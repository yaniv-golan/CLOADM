// The ROM call census and the token probe (tools/census/, local-only tools: tools/census/README.md), run here on
// the built-in firmware alone - no ROM. Their output must hold addresses and effects, never a byte of ROM, by
// construction (tools/census/lib.js's header gives the rules):
//  - census: the self-test program (tools/census/selftest/calls.asm) calls the firmware's ROM stub the ways a
//    program calls BASIC (through the $A000 vectors, directly, with a jump): each call gives a record with its
//    target, caller, kind, registers in and out, cycles and RAM writes; a call whose ROM code reads ROM data is
//    refused (addresses only) and recording stops when it returns; the CLI writes JSONL and the aggregate JSON;
//  - the leak paths, each on the built-in stub ROM: a program that reads ROM and computes on it (discarded), one that
//    keeps a refused call's ROM byte in RAM and passes it on (recording stopped before), the hardware vectors at
//    $FFF0-$FFFF (masked: discarded), a JMP through a ROM word outside the $A000 vectors (discarded), a ROM scan;
//  - RAM filled with ROM data before the program starts (the boot's RAM hooks), with a driven machine: program code
//    reading it stops recording, ROM code reading it refuses the record, a RAM hook (JMP) fetched from it is fine;
//  - the census CLI's own guards: its tripwire discards a program whose values hold a 16-byte ROM run, a script may
//    not read the machine out, a program BASIC started (not the census loader) records nothing;
//  - tokens: on a stand-in line editor (tools/census/selftest/fakebasic.asm, made-up keywords and tokens), each
//    keyword's stored line is found by its shape in RAM; a line holding a byte that is neither a token nor typed is
//    refused;
//  - mutants of every guard each turn a check here red.
// Run: node tests/census.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const Emu = require('./load')();
const { stubRom } = require('../js/machines/stub.js');
const { romWindowIn, windowIndex } = require('../js/media/romrefs.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tools', 'census');
const LIB = path.join(DIR, 'lib.js'), CENSUS = path.join(DIR, 'census.js'), TOKENS = path.join(DIR, 'tokens.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-census-'));
const tmp = (n) => path.join(TMP, n);
const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const hex = (v) => '$' + v.toString(16).toUpperCase();

const STUB = stubRom('6809', 0x4000, 0x8000);
const sym = (n) => STUB.symbols.get(n);
const STUB_IMG = [{ bytes: STUB.rom }];
const CALLS = fs.readFileSync(path.join(DIR, 'selftest', 'calls.asm'), 'utf8');
const FAKE = fs.readFileSync(path.join(DIR, 'selftest', 'fakebasic.asm'), 'utf8');
const equ = (src, name) => { const m = new RegExp(`^${name}\\s+EQU\\s+\\$([0-9A-F]+)`, 'm').exec(src); return m ? parseInt(m[1], 16) : null; };
const asm = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

// a module of tools/census with some text replaced, compiled at its own path (its requires still resolve)
function moduleWith(file, pairs = []) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { if (!src.includes(a)) throw new Error(`mutant: "${a}" is not in ${path.basename(file)}`); src = src.split(a).join(b); }
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(DIR);
  m._compile(src, file);
  return m.exports;
}
const lib = require(LIB);

// trace a program on the built-in firmware with a lib -> finish()'s result, plus tripped and symbols
function traced(L, src, { frames = 5, maxTargets = 512 } = {}) {
  const m = Emu.createMachine('dragon64');
  m.reset(true); m.runFrame();
  const r = asm(src);
  const t = L.trace(m, { program: 'p', maxTargets });
  m.injectAndRun(r.segments, r.exec);
  for (let i = 0; i < frames && !t.error; i++) m.runFrame();
  const out = t.finish();
  const tw = new L.Tripwire(L.romImages(m));
  out.tripped = out.records.some((x) => tw.add(L.valueBytes(x)));
  out.symbols = r.symbols;
  return out;
}
const PROG = (x) => x.from >= 0x3000 && x.from < 0x3100;
const prog = (body) => `
CHROUT  EQU     $B110
SKIP    EQU     $B275
OKMSG   EQU     $B2B2
        ORG     $3000
START
${body}
DONE    BRA     DONE
SAVE    FCB     0
        END     START`;

// ---------------- the self-test program against the stub ----------------
for (const n of ['CHROUT', 'NUM', 'SKIP', 'OKMSG']) check(`calls.asm's ${n} is the stub's ${n} (${hex(sym(n))})`, equ(CALLS, n) === sym(n));
check('the stub vectors: [$A000] is POLCAT, [$A002] is CHROUT', ((STUB.rom[0x2000] << 8) | STUB.rom[0x2001]) === sym('POLCAT') && ((STUB.rom[0x2002] << 8) | STUB.rom[0x2003]) === sym('CHROUT'));

const base = traced(lib, CALLS);
const at = (label) => base.symbols.get(label);
const find = (list, target, kind) => list.filter((x) => x.target === target && x.kind === kind && PROG(x));
{
  check('the program was started by the census loader, nothing discarded', base.started && !base.error, JSON.stringify(base.error));
  const [c1] = find(base.records, sym('CHROUT'), 'jsr-indirect');
  check('1. JSR [$A002]: a jsr-indirect record into CHROUT, from the program, A in = "H", back at the next instruction',
    c1 && c1.from === at('START') + 2 && c1.regsIn.a === 0x48 && c1.regsOut.pc === c1.from + 4 && c1.regsOut.s === c1.regsIn.s + 2, JSON.stringify(c1));
  check('... the registers start clean (the census loader clears A, B, X, Y, U, DP)', c1 && c1.regsIn.b === 0 && c1.regsIn.x === 0 && c1.regsIn.y === 0 && c1.regsIn.u === 0 && c1.regsIn.dp === 0);
  const [c2] = find(base.records, sym('CHROUT'), 'jsr');
  check('2. JSR CHROUT: a jsr record, A in = "I"', c2 && c2.regsIn.a === 0x49 && c2.cyclesInRom > 0, JSON.stringify(c2));
  const [c3] = find(base.records, sym('NUM'), 'jsr');
  const w = c3 ? c3.ramWritesOutsideRom : [];
  check('3. JSR NUM: D out = 123, X out past "123", and its RAM writes (NUMT = 123 last, NUM2) are recorded',
    c3 && c3.regsOut.a === 0 && c3.regsOut.b === 123 && c3.regsOut.x === c3.regsIn.x + 3 && w.length > 4 &&
    w.some((x) => x.addr === sym('NUMT') + 1 && x.value === 123) && w.some((x) => x.addr === sym('NUM2') + 1) && w.every((x) => !lib.masked(x.addr)), JSON.stringify(c3));
  const [c4] = find(base.records, sym('POLCAT'), 'jmp-indirect');
  check('4. JMP [$A000]: a jmp-indirect record into POLCAT, out at RET4', c4 && c4.regsOut.pc === at('RET4'), JSON.stringify(c4));
  const r5 = base.refused.filter((x) => x.target === sym('SKIP') && PROG(x));
  check('5. JSR SKIP (its ROM code reads ROM data): refused, written as its addresses only, and recording stopped',
    r5.length === 1 && Object.keys(r5[0]).sort().join() === 'from,kind,program,refused,target' && find(base.records, sym('SKIP'), 'jsr').length === 0 && base.stopped === 'rom-data-returned', JSON.stringify([r5, base.stopped]));
  check('6. the CHROUT after it, with the ROM byte in A, is neither recorded nor refused (nothing after the stop)',
    ![...base.records, ...base.refused].some((x) => x.from === at('RET4') + 6));
  check('the tripwire quiet, no window of the stub ROM in the values', !base.tripped);
}

// ---------------- the leak paths, each on the stub ROM ----------------
const LEAKS = {
  // a program reading ROM itself and computing on it, passing the result to a ROM call (rule 2)
  computed: prog(`        LDX     #$B200
LP      LDA     ,X+
        EORA    #$5A
        TFR     A,B
        JSR     CHROUT
        CMPX    #$B220
        BNE     LP`),
  // a refused call's ROM byte kept in RAM by the program and passed on later (rule 4)
  roundTrip: prog(`        LDX     #OKMSG
        JSR     SKIP
        STA     SAVE
        CLRA
        LDB     SAVE
        JSR     CHROUT`),
  // the hardware vectors at $FFF0-$FFFF are ROM bytes too (masked; rule 2)
  vectors: prog(`        LDD     $FFFE
        TFR     D,Y
        JSR     CHROUT`),
  // a JMP through a ROM word that is not one of BASIC's call vectors (rule 2): its target would be a ROM word
  pointer: prog(`        LDX     #BACK
        PSHS    X
        JMP     [$BFFE]
BACK    NOP`),
  // the stub's whole ROM copied out through CHROUT, byte by byte
  copy: prog(`        LDY     #$B200
LP      LDA     ,Y+
        JSR     CHROUT
        CMPY    #$B220
        BNE     LP`),
  // every ROM address entered in turn: a scan
  scan: prog(`        LDX     #$8000
LP      JSR     ,X
        LEAX    1,X
        CMPX    #$8040
        BNE     LP`),
};
const leakChecks = {
  computed: (r) => r.error === 'program-read-rom' && !r.records.length && !r.refused.length,
  roundTrip: (r) => !r.error && r.stopped === 'rom-data-returned' && r.refused.length === 1 && r.refused[0].target === sym('SKIP') && !r.records.some((x) => x.target === sym('CHROUT') && PROG(x)),
  vectors: (r) => r.error === 'program-read-rom' && !r.records.length,
  pointer: (r) => r.error === 'program-read-rom' && !r.records.some((x) => x.target === ((STUB.rom[0x3FFE] << 8) | STUB.rom[0x3FFF])),
  copy: (r) => r.error === 'program-read-rom' && !r.records.length,
  scan: (r) => /^scan/.test(r.error || ''),
};
const leakRun = (L, k) => traced(L, LEAKS[k], { maxTargets: 32 });
const descr = {
  computed: 'a program that reads ROM (LDA ,X+), computes on it (EORA) and passes it in B to CHROUT is discarded',
  roundTrip: 'a refused call\'s ROM byte, stored in RAM by the program and passed to CHROUT later: recording stopped before it',
  vectors: 'LDD $FFFE (the reset vector, ROM through the SAM) by the program is a ROM read: discarded',
  pointer: 'JMP [$BFFE] (a ROM word outside the $A000 vectors as a pointer) is a ROM read: discarded, its target never recorded',
  copy: 'a program copying ROM bytes to CHROUT is discarded',
  scan: 'a program entering more distinct ROM addresses than --max-targets is discarded as a scan',
};
for (const k of Object.keys(LEAKS)) { const r = leakRun(lib, k); check(descr[k], leakChecks[k](r), JSON.stringify({ error: r.error, stopped: r.stopped, n: r.records.length, refused: r.refused })); }

// ---------------- RAM filled with ROM data before the program starts: a driven machine ----------------
// A stand-in machine whose probe and taps the test calls itself, instruction by instruction, so the boot can copy a
// ROM byte into RAM (as BASIC's boot fills its RAM hooks) without any ROM.
function driven(L) {
  const mem = new Uint8Array(0x10000), probes = [], reads = [], writes = [];
  const m = {
    cpu: { a: 0, b: 0, x: 0, y: 0, u: 0, s: 0x7F00, dp: 0, cc: 0, pc: 0 }, cycle: 0, peek: (a) => mem[a],
    addProbe(fn) { probes.push(fn); return () => {}; },
    busTaps: { addReadTap(r, fn) { reads.push(fn); return () => {}; }, addWriteTap(r, fn) { writes.push(fn); return () => {}; } },
    injectAndRun(segs, exec) { for (const s of segs) mem.set(s.data, s.addr); this.cpu.pc = exec; },
  };
  const t = L.trace(m, { program: 'd' });
  const d = {
    mem, t, m,
    step(pc) { m.cpu.pc = pc; m.cycle += 4; for (const f of probes) f(pc); },
    fetch(pc, n) { for (let i = 0; i < n; i++) { m.cpu.pc = pc + i; for (const f of reads) f(pc + i, mem[pc + i]); } m.cpu.pc = pc + n; },
    read(a) { for (const f of reads) f(a, mem[a]); },
    write(a, v) { mem[a] = v; for (const f of writes) f(a, v); },
    // the boot: ROM code at $8100 reads a ROM byte and writes it to `cell`
    boot(cell, value) { mem[0x8200] = value; d.step(0x8100); d.fetch(0x8100, 3); d.read(0x8200); d.write(cell, value); d.step(0x8103); },
    start() { m.injectAndRun([{ addr: 0x3000, data: [0x12, 0x12, 0x12] }], 0x3000); },
  };
  return d;
}
const bootScenarios = {
  // program code reads a cell the boot filled with a ROM byte: recording stops; the ROM call after it is not recorded
  programReads(L) {
    const d = driven(L);
    d.boot(0x0500, 0x42); d.start();
    d.step(0x3000); d.fetch(0x3000, 3); d.read(0x0500);
    d.step(0x3003); d.step(0xB110); d.step(0x3006);
    return d.t.finish();
  },
  // ROM code reads that cell during a call: the record is refused, and recording stops when it returns
  romReads(L) {
    const d = driven(L);
    d.boot(0x0500, 0x42); d.start();
    d.step(0x3000); d.fetch(0x3000, 3);
    d.step(0xB110); d.fetch(0xB110, 3); d.read(0x0500);
    d.step(0x3003);
    return d.t.finish();
  },
  // a RAM hook: the boot copies JMP $B110 to $010C; program code runs it, and the JMP into ROM is recorded
  hook(L) {
    const d = driven(L);
    d.boot(0x010C, 0x7E); d.boot(0x010D, 0xB1); d.boot(0x010E, 0x10); d.start();
    d.step(0x010C); d.fetch(0x010C, 3);
    d.step(0xB110); d.fetch(0xB110, 1);
    d.step(0x3000);
    return d.t.finish();
  },
  // the same cell holding an LDA # instead: running it puts the ROM byte in A, so recording stops
  hookLoad(L) {
    const d = driven(L);
    d.boot(0x010C, 0x86); d.boot(0x010D, 0x42); d.start();
    d.step(0x010C); d.fetch(0x010C, 2);
    d.step(0x010E); d.step(0xB110); d.step(0x3000);
    return d.t.finish();
  },
};
const bootChecks = {
  programReads: (r) => r.stopped === 'program-read-rom-data' && !r.records.length && !r.refused.length,
  romReads: (r) => r.stopped === 'rom-data-returned' && !r.records.length && r.refused.length === 1 && r.refused[0].target === 0xB110,
  hook: (r) => !r.stopped && r.records.length === 1 && r.records[0].from === 0x010C && r.records[0].kind === 'jmp',
  hookLoad: (r) => r.stopped === 'program-ran-rom-data' && !r.records.length,
};
const bootDescr = {
  programReads: 'program code reading RAM the boot filled from ROM stops recording before its next ROM call',
  romReads: 'ROM code reading that RAM refuses the record (addresses only) and stops recording on return',
  hook: 'a RAM hook the boot copied from ROM (JMP $B110) runs, and its jump into ROM is recorded',
  hookLoad: 'an instruction other than JMP/JSR/RTS fetched from such RAM (LDA #) stops recording',
};
for (const k of Object.keys(bootScenarios)) { const r = bootScenarios[k](lib); check(bootDescr[k], bootChecks[k](r), JSON.stringify(r)); }

// ---------------- the pieces ----------------
{
  check('masked: $8000-$FEFF and $FFF0-$FFFF, not the I/O page $FF00-$FFEF, not RAM', lib.masked(0x8000) && lib.masked(0xC000) && lib.masked(0xFEFF) && lib.masked(0xFFF0) && lib.masked(0xFFFF) && !lib.masked(0xFF00) && !lib.masked(0xFFEF) && !lib.masked(0x7FFF));
  const peek = (img) => (a) => img[a] || 0;
  const jsrVec = { 0x3000: 0xAD, 0x3001: 0x9F, 0x3002: 0xA0, 0x3003: 0x02 };
  check('onlyPicksTarget: JSR [$A002] reading $A002-$A003 and landing there', lib.onlyPicksTarget([[0xA002, 0xB1], [0xA003, 0x10]], peek(jsrVec), 0x3000, 0xB110, -2));
  check('onlyPicksTarget: not when landing elsewhere, not outside $A000-$A00F, not for another instruction', !lib.onlyPicksTarget([[0xA002, 0xB1], [0xA003, 0x10]], peek(jsrVec), 0x3000, 0xB111, -2) &&
    !lib.onlyPicksTarget([[0xA010, 0xB1], [0xA011, 0x10]], peek({ 0x3000: 0xAD, 0x3001: 0x9F, 0x3002: 0xA0, 0x3003: 0x10 }), 0x3000, 0xB110, -2) &&
    !lib.onlyPicksTarget([[0xA002, 0xB1], [0xA003, 0x10]], peek({ 0x3000: 0xFC, 0x3001: 0xA0, 0x3002: 0x02 }), 0x3000, 0xB110, 0));
  check('onlyPicksTarget: an interrupt vector fetch ($FFF8, S down 12) landing at the handler, but not without the stacking',
    lib.onlyPicksTarget([[0xFFF8, 0x01], [0xFFF9, 0x0C]], peek({}), 0x3000, 0x010C, -12) && !lib.onlyPicksTarget([[0xFFF8, 0x01], [0xFFF9, 0x0C]], peek({}), 0x3000, 0x010C, 0));
  const run = [...STUB.rom.subarray(0x3200, 0x3210)];
  check('Tripwire: values with no ROM run pass', new lib.Tripwire(STUB_IMG).add([1, 2, 3]) === null);
  check('Tripwire: a planted 16-byte run of the ROM image, split over two records, trips it', (() => { const t = new lib.Tripwire(STUB_IMG); return t.add(run.slice(0, 7)) === null && t.add(run.slice(7)) !== null; })());
  check('kindOf: an instruction inside the masked range is never read (from-rom)', lib.kindOf(() => { throw new Error('read'); }, 0xC123, -2) === 'from-rom');
}

// ---------------- the CLI: census.js ----------------
const census = require(CENSUS);
const quiet = { log: () => {} };
const opts = (o = {}) => Object.assign(census.parse(['--no-roms', '--frames', '5', 'x']), o);
(async () => {
  {
    const script = tmp('calls.cloadm');
    fs.writeFileSync(script, `asm ${path.join(DIR, 'selftest', 'calls.asm')}\nframes 5\n`);
    const bin = tmp('calls.bin');
    const a = node([path.join(ROOT, 'cli', 'cloadm.js'), '--assemble', path.join(DIR, 'selftest', 'calls.asm'), '--machine', 'dragon64', '--out', bin]);
    check('the self-test program assembles to a .bin with the CLI', a.status === 0, a.stderr);
    const out = tmp('out');
    const r = node([CENSUS, '--no-roms', '--frames', '5', '--out', out, script, bin]);
    check('census.js runs a script and a .bin, exit 0', r.status === 0, r.stderr);
    const lines = fs.readFileSync(path.join(out, 'census.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const agg = JSON.parse(fs.readFileSync(path.join(out, 'census.json'), 'utf8'));
    for (const p of ['calls.cloadm', 'calls.bin']) {
      const mine = lines.filter((l) => l.program === p);
      check(`${p}: CHROUT, NUM and POLCAT in census.jsonl, SKIP only as refused, nothing after it`,
        mine.some((l) => l.target === sym('CHROUT') && l.kind === 'jsr-indirect' && l.regsIn) && mine.some((l) => l.target === sym('NUM') && l.regsOut) &&
        mine.some((l) => l.target === sym('POLCAT') && l.kind === 'jmp-indirect') && mine.filter((l) => l.target === sym('SKIP')).length === 1 &&
        mine.filter((l) => l.target === sym('SKIP')).every((l) => l.refused && !l.regsOut) && mine.length === 5, `${mine.length} lines`);
    }
    const keys = ['program', 'target', 'from', 'kind', 'regsIn', 'regsOut', 'cyclesInRom', 'ramWritesOutsideRom'];
    check('every written record has exactly the record fields (plus writesDropped/open)', lines.filter((l) => !l.refused).every((l) => keys.every((k) => k in l) && Object.keys(l).every((k) => keys.includes(k) || k === 'writesDropped' || k === 'open')));
    check('every refused line holds addresses only', lines.filter((l) => l.refused).every((l) => Object.keys(l).sort().join() === 'from,kind,program,refused,target'));
    const chrout = agg.entries.find((e) => e.address === sym('CHROUT'));
    check('census.json: entries sorted by the number of programs using them, with calls, registers and RAM effects; each run says why recording stopped',
      agg.entries.every((e, i) => i === 0 || agg.entries[i - 1].programs.length >= e.programs.length) && agg.entries[0].programs.length === 2 &&
      chrout && chrout.programs.length === 2 && chrout.calls === 4 && chrout.inRegs.a.values.includes(0x48) &&
      agg.entries.find((e) => e.address === sym('NUM')).ramEffects.some((x) => x.addr === sym('NUMT') + 1 && x.values.includes(123)) &&
      agg.programs.length === 2 && agg.programs.every((p) => p.stopped === 'rom-data-returned'));
    const vals = Uint8Array.from(lines.filter((l) => !l.refused).flatMap((l) => lib.valueBytes(l)));
    check('no output holds a window of the stub ROM', romWindowIn(vals, STUB_IMG, windowIndex(STUB_IMG)) === null &&
      romWindowIn(Uint8Array.from(JSON.stringify(agg).match(/\d+/g).map(Number).filter((v) => v < 256)), STUB_IMG, windowIndex(STUB_IMG)) === null);
    const rn = node([CENSUS, script]);
    check('census.js without --roms (or --no-roms) refuses to run', rn.status === 2 && /--roms PATH is required/.test(rn.stderr));
  }

  // a script that reads the machine out: refused for that reason, by the allow-list
  const peekScript = tmp('peek.cloadm');
  fs.writeFileSync(peekScript, `asm ${path.join(DIR, 'selftest', 'calls.asm')}\npeek $8000:16\n`);
  const peekRun = async (mod) => { const logs = []; const code = await mod.main(['--no-roms', '--out', tmp('out-peek'), peekScript], { log: (t) => logs.push(t) }); return { code, log: logs.join('\n') }; };
  const allowListHolds = (r) => r.code === 1 && /peek\.cloadm: discarded \([^)]*a census script may not use the step "peek"\)/.test(r.log) && fs.readFileSync(path.join(tmp('out-peek'), 'census.jsonl'), 'utf8').trim() === '';
  {
    const r = await peekRun(census);
    check('a census script with a peek step is refused by the allow-list (that reason), nothing recorded', allowListHolds(r), r.log);
  }
  // a program started by BASIC (here: typed at the stub), not by the census loader: nothing recorded
  {
    const s = tmp('typed.cloadm');
    fs.writeFileSync(s, 'type "POKE 1024,1\\n"\nframes 5\n');
    const r = await census.runProgram(s, opts(), lib);
    check('a run the census loader did not start records nothing (discarded: not started)', /^not started/.test(r.error || '') && !r.records.length, JSON.stringify(r.error));
  }
  // census.js's own tripwire: a tracer that lets a ROM run through (planted) has its program discarded
  const planted = Object.assign({}, lib, {
    trace: (m) => ({ error: null, finish: () => ({ started: true, stopped: null, error: null, refused: [],
      records: [{ program: 'p', target: 0xB110, from: 0x3000, kind: 'jsr', regsIn: {}, regsOut: {}, cyclesInRom: 1, ramWritesOutsideRom: [...STUB.rom.subarray(0x3200, 0x3210)].map((v, i) => ({ addr: 0x400 + i, value: v })) }] }) }),
  });
  const tripHolds = (r) => /^tripwire/.test(r.error || '') && !r.records.length;
  {
    const s = tmp('calls2.cloadm');
    fs.writeFileSync(s, `asm ${path.join(DIR, 'selftest', 'calls.asm')}\nframes 1\n`);
    check('census.js applies the tripwire: planted ROM bytes in a record discard the program', tripHolds(await census.runProgram(s, opts(), planted)));

    // ---------------- tokens.js ----------------
    const tokens = require(TOKENS);
    const BOOT = tmp('boot.cloadm');
    const bootFor = (src) => { const f = tmp(`fake-${Math.random().toString(36).slice(2)}.asm`); fs.writeFileSync(f, src); fs.writeFileSync(BOOT, `asm ${f}\nwait-for text:(^|\\n)OK *(\\n|$)\n`); return BOOT; };
    const KW = tmp('kw.txt');
    fs.writeFileSync(KW, '# typed from the manual\nALPHA\nbeta\nGO\nZED\n+\n');
    const probe = async (src, mod = tokens) => {
      const outs = [];
      const code = await mod.main(['--no-roms', '--boot', bootFor(src), '--keywords', KW], { log: () => {}, out: (t) => outs.push(t) });
      return { code, json: outs.length ? JSON.parse(outs.join('\n')) : null };
    };
    {
      const { code, json } = await probe(FAKE);
      const by = Object.fromEntries((json ? json.results : []).map((x) => [x.keyword, x.bytes]));
      check('tokens: each keyword\'s stored line read back from RAM: its made-up token, or its letters',
        code === 0 && by.ALPHA.join() === '193' && by.BETA.join() === '194' && by.GO.join() === '195' && by.ZED.join() === '90,69,68' && by['+'].join() === '43', JSON.stringify(json));
    }
    check('tokens: the keyword list refuses anything but keywords', (() => {
      const bad = tmp('kw-bad.txt');
      return ['PRINT:POKE', 'A B', '10', 'PEEK(1)', 'TOOLONGKEYWORD'].every((x) => { fs.writeFileSync(bad, x + '\n'); try { tokens.readKeywords(bad); return false; } catch (e) { return true; } });
    })());
    check('tokens: findLine wants the whole shape (next-line address just past the line, then 00 00)', (() => {
      const mem = new Uint8Array(0x10000);
      mem.set([0x40, 0x08, 0x00, 0x0A, 0xC1, 0x41, 0x00, 0x00, 0x00, 0x00], 0x4001);
      const ok = tokens.findLine((a) => mem[a], 10);
      mem[0x4008] = 1;
      return ok && ok.join() === '193,65' && tokens.findLine((a) => mem[a], 10) === null;
    })());
    check('tokens: guardLine refuses a byte that is neither a token nor typed, and over-long lines',
      tokens.guardLine('10 GO', [0xC3]) === null && tokens.guardLine('10 GO', [0x10]) !== null && tokens.guardLine('10 GO', [0xC3, 0xC3, 0xC3, 0xC3, 0xC3, 0xC3]) !== null && tokens.guardLine('10 GO', null) !== null);
    const LEAKY = FAKE.replace('KWHIT   STA     ,Y+', 'KWHIT   LDA     $A003\n        STA     ,Y+');
    const tokenGuardHolds = (r) => r.code === 1 && r.json.results.every((x) => x.keyword === 'ZED' || x.keyword === '+') && r.json.failed.filter((f) => /neither a token/.test(f.error)).length === 3;
    {
      const r = await probe(LEAKY);
      check('tokens: a line holding a planted ROM byte is refused, its bytes not written', tokenGuardHolds(r), JSON.stringify(r.json));
    }

    // ---------------- mutants: each must turn a check red ----------------
    const libMutants = [
      ['program code reading ROM not discarded (rule 2)', [["if (!romCode) { if (started && !stopped) error = 'program-read-rom'; }", 'if (!romCode) { }']], ['computed', 'vectors', 'copy', 'pointer']],
      ['the vector exemption for any two reads that land where they point', [['if (a0 < VEC_LO || a1 > VEC_HI) return false;', 'return true;']], ['pointer']],
      ['$FFF0-$FFFF not masked', [['const masked = (a) => a >= 0x8000 && !(a >= IO_LO && a <= IO_HI);', 'const masked = (a) => a >= 0x8000 && a < IO_LO;']], ['vectors']],
      ['ROM code reading ROM data not making its stretch dirty', [['else dirtyStretch = true;', 'else { }']], ['roundTrip']],
      ['taint not sticky (recording goes on after a dirty stretch returns)', [["if (dirtyStretch && started) stop('rom-data-returned');", '']], ['roundTrip']],
      ['the boot not marking RAM it fills from ROM', [['else dirtyRam[a] = v !== 0 && v !== 0xFF && recent.includes(v) ? 1 : 0;', 'else dirtyRam[a] = 0;']], ['programReads', 'romReads']],
      ['program code reading dirty RAM ignored', [["else if (started) stop('program-read-rom-data');", 'else { }']], ['programReads']],
      ['ROM code reading dirty RAM ignored', [['if (masked(curPc)) { dirtyStretch = true; return; }', 'if (masked(curPc)) { return; }']], ['romReads']],
      ['dirty RAM fetched as any instruction allowed', [["if (!romCode && fetchDirty && !HOOK_OPS.has(peek(from)) && started) stop('program-ran-rom-data');", '']], ['hookLoad']],
      ['the scan limit off', [['if (targets.size > maxTargets)', 'if (false)']], ['scan']],
      ['the lib tripwire off', [['return romWindowIn(Uint8Array.from(this.stream.slice(from))', 'return null && romWindowIn(Uint8Array.from(this.stream.slice(from))']], ['tripwire']],
    ];
    for (const [name, pairs, scenarios] of libMutants) {
      const L = moduleWith(LIB, pairs);
      const caught = scenarios.some((k) => {
        if (leakChecks[k]) return !leakChecks[k](leakRun(L, k));
        if (bootChecks[k]) return !bootChecks[k](bootScenarios[k](L));
        const t = new L.Tripwire(STUB_IMG); t.add([...STUB.rom.subarray(0x3200, 0x3207)]); return t.add([...STUB.rom.subarray(0x3207, 0x3210)]) === null;
      });
      check(`mutant "${name}" is caught`, caught);
    }
    {
      const C = moduleWith(CENSUS, [['for (const x of r.records) if (tw.add(lib.valueBytes(x)))', 'for (const x of r.records) if (false && tw.add(lib.valueBytes(x)))']]);
      check('mutant "census tripwire not applied" is caught', !tripHolds(await C.runProgram(s, opts(), planted)));
      const A = moduleWith(CENSUS, [['if (!ALLOWED.has(s.name))', 'if (false)']]);
      check('mutant "script allow-list off" is caught', !allowListHolds(await peekRun(A)));
      const T = moduleWith(TOKENS, [['if (b < 0x80 && !chars.has(b))', 'if (false)']]);
      check('mutant "token guard off" is caught', !tokenGuardHolds(await probe(LEAKY, T)));
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  if (fail) { console.log(`\n${fail} check(s) failed`); process.exitCode = 1; return; }
  console.log('\nall census checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
