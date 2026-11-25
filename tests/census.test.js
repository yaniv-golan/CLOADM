// The ROM call census and the token probe (tools/census/, local-only tools: tools/census/README.md), run here on
// the built-in firmware alone - no ROM. Their output must hold addresses and effects, never a byte of ROM.
//  - census: the self-test program (tools/census/selftest/calls.asm) calls the firmware's ROM stub the ways a
//    program calls BASIC (through the $A000 vectors, directly, with a jump): each call gives a record with its
//    target, caller, kind, registers in and out, cycles and RAM writes; the CLI writes them as JSONL and the
//    aggregate as JSON, from a .cloadm script and from a .bin;
//  - the guard: a call that returns a byte read from ROM (SKIP with X in ROM) is refused, and so is the next call
//    made with that byte still in A; a program that copies ROM bytes and passes them to CHROUT gets every such call
//    refused; a planted record with a tainted value is refused (guardRecord); a planted 16-byte run of the ROM image
//    in the output values trips the romrefs window check (Tripwire); a program that scans ROM entry points is
//    discarded; a census script may not read the machine out (peek, screen, ...);
//  - no output contains ROM bytes: no 16-byte window of the stub ROM in any output's value stream, no write address
//    in $8000-$FEFF, and none of the bytes the refused calls read from ROM appear in their place;
//  - tokens: on a stand-in line editor (tools/census/selftest/fakebasic.asm, its own made-up keywords and tokens),
//    each keyword's stored line is found by its shape in RAM and its bytes reported; a keyword list with anything but
//    keywords is refused; a line holding a byte that is neither a token nor a typed character is refused;
//  - mutants of the guard (data reads not tainted, registers not followed, the tripwire off, the token guard off)
//    each turn a check here red.
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
const LIB = path.join(DIR, 'lib.js');
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

// a copy of lib.js with some text replaced, loaded as a module at lib.js's own path (its requires still resolve)
function libWith(pairs = []) {
  let src = fs.readFileSync(LIB, 'utf8');
  for (const [a, b] of pairs) { if (!src.includes(a)) throw new Error(`mutant: "${a}" is not in lib.js`); src = src.split(a).join(b); }
  const m = new Module(LIB, module);
  m.filename = LIB; m.paths = Module._nodeModulePaths(DIR);
  m._compile(src, LIB);
  return m.exports;
}
// trace a program on the built-in firmware with a lib -> { records, refused, error, written (passed the tripwire) }
function traced(lib, src, { frames = 5, maxTargets = 512 } = {}) {
  const m = Emu.createMachine('dragon64');
  m.reset(true); m.runFrame();
  const r = asm(src);
  const t = lib.trace(m, { program: 'p', maxTargets });
  m.injectAndRun(r.segments, r.exec);
  for (let i = 0; i < frames && !t.error; i++) m.runFrame();
  const out = t.finish();
  const tw = new lib.Tripwire(lib.romImages(m));
  out.tripped = out.records.some((x) => tw.add(lib.valueBytes(x)));
  out.symbols = r.symbols;
  return out;
}
const lib = require(LIB);

// ---------------- the self-test program against the stub ----------------
for (const n of ['CHROUT', 'NUM', 'SKIP', 'OKMSG']) check(`calls.asm's ${n} is the stub's ${n} (${hex(sym(n))})`, equ(CALLS, n) === sym(n));
check('the stub vectors: [$A000] is POLCAT, [$A002] is CHROUT', ((STUB.rom[0x2000] << 8) | STUB.rom[0x2001]) === sym('POLCAT') && ((STUB.rom[0x2002] << 8) | STUB.rom[0x2003]) === sym('CHROUT'));

const base = traced(lib, CALLS);
const at = (label) => base.symbols.get(label);
const find = (list, target, kind) => list.filter((x) => x.target === target && x.kind === kind && x.from >= 0x3000 && x.from < 0x3100);
{
  const [c1] = find(base.records, sym('CHROUT'), 'jsr-indirect');
  check('1. JSR [$A002]: a jsr-indirect record into CHROUT, from the program, A in = "H", back at the next instruction',
    c1 && c1.from === at('START') + 2 && c1.regsIn.a === 0x48 && c1.regsOut.pc === c1.from + 4 && c1.regsOut.s === c1.regsIn.s + 2, JSON.stringify(c1));
  const [c2] = find(base.records, sym('CHROUT'), 'jsr');
  check('2. JSR CHROUT: a jsr record, A in = "I"', c2 && c2.regsIn.a === 0x49 && c2.cyclesInRom > 0, JSON.stringify(c2));
  const [c3] = find(base.records, sym('NUM'), 'jsr');
  const w = c3 ? c3.ramWritesOutsideRom : [];
  check('3. JSR NUM: D out = 123, X out past "123", and its RAM writes (NUMT = 123 last, NUM2) are recorded',
    c3 && c3.regsOut.a === 0 && c3.regsOut.b === 123 && c3.regsOut.x === c3.regsIn.x + 3 && w.length > 4 &&
    w.some((x) => x.addr === sym('NUMT') + 1 && x.value === 123) && w.some((x) => x.addr === sym('NUM2') + 1) && w.every((x) => x.addr < 0x8000 || x.addr > 0xFEFF), JSON.stringify(c3));
  const [r4] = find(base.refused, sym('SKIP'), 'jsr');
  check('4. JSR SKIP with X in ROM (A out is a ROM byte): refused, kept as addresses only',
    r4 && r4.refused === 'tainted-register-out' && !('regsOut' in r4) && !('regsIn' in r4) && find(base.records, sym('SKIP'), 'jsr').length === 0, JSON.stringify(r4));
  const r5 = base.refused.find((x) => x.target === sym('CHROUT') && x.from === at('START') + 0x1A);
  check('5. JSR CHROUT with that ROM byte still in A: refused (tainted-register-in)', r5 && r5.refused === 'tainted-register-in', JSON.stringify(base.refused));
  const [c6] = find(base.records, sym('POLCAT'), 'jmp-indirect');
  check('6. JMP [$A000]: a jmp-indirect record into POLCAT, out at RET6', c6 && c6.regsOut.pc === at('RET6'), JSON.stringify(c6));
  check('interrupts through the RAM vector are records of their own (jmp from $010C into the IRQ handler)', base.records.some((x) => x.from === 0x010C && x.kind === 'jmp' && x.target === sym('IRQ')));
  check('no error, the tripwire quiet', !base.error && !base.tripped);
}

// ---------------- no output holds ROM bytes ----------------
const streamOf = (records) => Uint8Array.from(records.flatMap((r) => lib.valueBytes(r)));
const noRom = (records) => romWindowIn(streamOf(records), STUB_IMG, windowIndex(STUB_IMG)) === null;
check('no 16-byte window of the stub ROM in the value stream', noRom(base.records));
check('no write address in $8000-$FEFF in any record', base.records.every((r) => r.ramWritesOutsideRom.every((w) => !lib.masked(w.addr))));
check('the ROM byte SKIP read ("O" of OKMSG) is in no register of a written record from the program', !base.records.some((r) => r.from >= 0x3000 && r.from < 0x3100 && (r.regsOut.a === STUB.rom[sym('OKMSG') - 0x8000] || r.regsIn.a === STUB.rom[sym('OKMSG') - 0x8000])));

// a program that copies ROM bytes itself and hands each to CHROUT: every such call must be refused
const LEAK = `
CHROUT  EQU     $B110
        ORG     $3000
START   LDY     #$B200
LP      LDA     ,Y+
        JSR     CHROUT
        CMPY    #$B220
        BNE     LP
DONE    BRA     DONE
        END     START`;
{
  const r = traced(lib, LEAK);
  const calls = (x) => x.target === sym('CHROUT') && x.from >= 0x3000 && x.from < 0x3100;
  const leakedRefused = r.refused.filter(calls), leakedWritten = r.records.filter(calls);
  const blanks = [...STUB.rom.subarray(0x3200, 0x3220)].filter((v) => v === 0 || v === 0xFF).length;
  check('a program passing 32 ROM bytes to CHROUT: every call but those with a blank byte (0, $FF) is refused',
    leakedRefused.length + leakedWritten.length === 32 && leakedWritten.length === blanks && leakedWritten.every((x) => x.regsIn.a === 0 || x.regsIn.a === 0xFF), `${leakedRefused.length} refused, ${leakedWritten.length} written, ${blanks} blank`);
  check('... and the value stream holds no window of the ROM', noRom(r.records) && !r.tripped);
}

// ---------------- the guard, with planted values ----------------
{
  const rec = { regsIn: { a: 1 }, regsOut: { a: 1, pc: 0x3000 }, ramWritesOutsideRom: [{ addr: 0x400, value: 0x55 }] };
  check('guardRecord: a clean record passes', lib.guardRecord(rec, new Set([0x77])) === null);
  check('guardRecord: a planted tainted write value is refused', lib.guardRecord(rec, new Set([0x55])) === 'tainted-write');
  check('guardRecord: a planted tainted register is refused', lib.guardRecord(rec, new Set([0x30])) === 'tainted-register-out' && lib.guardRecord({ ...rec, regsIn: { x: 0x1234 } }, new Set([0x12])) === 'tainted-register-in');
  check('guardRecord: a write into $8000-$FEFF is refused', lib.guardRecord({ ...rec, ramWritesOutsideRom: [{ addr: 0xC000, value: 1 }] }, new Set()) === 'write-in-masked-range');
  const tw = new lib.Tripwire(STUB_IMG);
  const run = [...STUB.rom.subarray(0x3200, 0x3210)];
  check('Tripwire: values that hold no ROM run pass', tw.add([1, 2, 3]) === null && tw.add(run.slice(0, 15)) === null);
  check('Tripwire: a planted 16-byte run of the ROM image, split over two records, trips it', new lib.Tripwire(STUB_IMG).add(run.slice(0, 7)) === null && (() => { const t = new lib.Tripwire(STUB_IMG); t.add(run.slice(0, 7)); return t.add(run.slice(7)) !== null; })());
  const sc = `
        ORG     $3000
START   LDX     #$8000
LP      JSR     ,X
        LEAX    1,X
        CMPX    #$8040
        BNE     LP
DONE    BRA     DONE
        END     START`;
  const r = traced(lib, sc, { maxTargets: 32 });
  check('a program entering more distinct ROM addresses than --max-targets is stopped as a scan', /^scan/.test(r.error || ''), r.error);
}

// ---------------- the CLI: census.js ----------------
{
  const script = tmp('calls.cloadm');
  fs.writeFileSync(script, `asm ${path.join(DIR, 'selftest', 'calls.asm')}\nframes 5\n`);
  const bin = tmp('calls.bin');
  const a = node([path.join(ROOT, 'cli', 'cloadm.js'), '--assemble', path.join(DIR, 'selftest', 'calls.asm'), '--machine', 'dragon64', '--out', bin]);
  check('the self-test program assembles to a .bin with the CLI', a.status === 0, a.stderr);
  const out = tmp('out');
  const r = node([path.join(DIR, 'census.js'), '--no-roms', '--frames', '5', '--out', out, script, bin]);
  check('census.js runs a script and a .bin, exit 0', r.status === 0, r.stderr);
  const lines = fs.readFileSync(path.join(out, 'census.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const agg = JSON.parse(fs.readFileSync(path.join(out, 'census.json'), 'utf8'));
  for (const p of ['calls.cloadm', 'calls.bin']) {
    const mine = lines.filter((l) => l.program === p);
    check(`${p}: the CHROUT, NUM and POLCAT calls are in census.jsonl, SKIP only as refused`,
      mine.some((l) => l.target === sym('CHROUT') && l.kind === 'jsr-indirect' && l.regsIn) && mine.some((l) => l.target === sym('NUM') && l.regsOut) &&
      mine.some((l) => l.target === sym('POLCAT') && l.kind === 'jmp-indirect') && mine.filter((l) => l.target === sym('SKIP')).every((l) => l.refused && !l.regsOut), `${mine.length} lines`);
  }
  const keys = ['program', 'target', 'from', 'kind', 'regsIn', 'regsOut', 'cyclesInRom', 'ramWritesOutsideRom'];
  check('every written record has exactly the record fields (plus writesDropped/open)', lines.filter((l) => !l.refused).every((l) => keys.every((k) => k in l) && Object.keys(l).every((k) => keys.includes(k) || k === 'writesDropped' || k === 'open')));
  check('every refused line holds addresses only', lines.filter((l) => l.refused).every((l) => Object.keys(l).sort().join() === 'from,kind,program,refused,target'));
  const e0 = agg.entries[0], chrout = agg.entries.find((e) => e.address === sym('CHROUT'));
  check('census.json: entries sorted by the number of programs using them, with calls, registers and RAM effects',
    agg.entries.every((e, i) => i === 0 || agg.entries[i - 1].programs.length >= e.programs.length) && e0.programs.length === 2 &&
    chrout && chrout.programs.length === 2 && chrout.calls >= 4 && chrout.refused >= 2 && chrout.inRegs.a.values.includes(0x48) &&
    agg.entries.find((e) => e.address === sym('NUM')).ramEffects.some((x) => x.addr === sym('NUMT') + 1 && x.values.includes(123)));
  check('the whole output (both files) holds no window of the stub ROM', noRom(lines.filter((l) => !l.refused)) &&
    romWindowIn(Uint8Array.from(JSON.stringify(agg).match(/\d+/g).map(Number).filter((v) => v < 256)), STUB_IMG, windowIndex(STUB_IMG)) === null);
  const bad = tmp('bad.cloadm');
  fs.writeFileSync(bad, `asm ${path.join(DIR, 'selftest', 'calls.asm')}\npeek $8000 16\n`);
  const rb = node([path.join(DIR, 'census.js'), '--no-roms', '--out', tmp('out2'), bad]);
  check('a census script that reads the machine out (peek) is refused, nothing recorded for it', rb.status === 1 && /bad\.cloadm: discarded/.test(rb.stderr) && fs.readFileSync(path.join(tmp('out2'), 'census.jsonl'), 'utf8').trim() === '', rb.stderr);
  const rn = node([path.join(DIR, 'census.js'), script]);
  check('census.js without --roms (or --no-roms) refuses to run', rn.status === 2 && /--roms PATH is required/.test(rn.stderr));
}

// ---------------- tokens.js ----------------
const tokens = require(path.join(DIR, 'tokens.js'));
const BOOT = tmp('boot.cloadm');
const bootFor = (src) => { const f = tmp(`fake-${Math.random().toString(36).slice(2)}.asm`); fs.writeFileSync(f, src); fs.writeFileSync(BOOT, `asm ${f}\nwait-for text:(^|\\n)OK *(\\n|$)\n`); return BOOT; };
const KW = tmp('kw.txt');
fs.writeFileSync(KW, '# typed from the manual\nALPHA\nbeta\nGO\nZED\n+\n');
async function probe(src, mod = tokens) {
  const outs = [];
  const code = await mod.main(['--no-roms', '--boot', bootFor(src), '--keywords', KW], { log: () => {}, out: (t) => outs.push(t) });
  return { code, json: outs.length ? JSON.parse(outs.join('\n')) : null };
}
(async () => {
  {
    const { code, json } = await probe(FAKE);
    const by = Object.fromEntries((json ? json.results : []).map((r) => [r.keyword, r.bytes]));
    check('tokens: each keyword\'s stored line read back from RAM: its made-up token, or its letters',
      code === 0 && by.ALPHA.join() === '193' && by.BETA.join() === '194' && by.GO.join() === '195' && by.ZED.join() === '90,69,68' && by['+'].join() === '43', JSON.stringify(json));
  }
  check('tokens: the keyword list refuses anything but keywords', (() => {
    const bad = tmp('kw-bad.txt');
    return ['PRINT:POKE', 'A B', '10', 'PEEK(1)', 'TOOLONGKEYWORD'].every((t) => { fs.writeFileSync(bad, t + '\n'); try { tokens.readKeywords(bad); return false; } catch (e) { return true; } });
  })());
  check('tokens: findLine wants the whole shape (next-line address just past the line, then 00 00)', (() => {
    const mem = new Uint8Array(0x10000);
    mem.set([0x40, 0x08, 0x00, 0x0A, 0xC1, 0x41, 0x00, 0x00, 0x00, 0x00], 0x4001);   // next = $4008, end marker there
    const ok = tokens.findLine((a) => mem[a], 10);
    mem[0x4008] = 1;
    const broken = tokens.findLine((a) => mem[a], 10);
    return ok && ok.join() === '193,65' && broken === null;
  })());
  check('tokens: guardLine refuses a byte that is neither a token nor typed, and over-long lines',
    tokens.guardLine('10 GO', [0xC3]) === null && tokens.guardLine('10 GO', [0x10]) !== null && tokens.guardLine('10 GO', [0xC3, 0xC3, 0xC3, 0xC3, 0xC3, 0xC3]) !== null && tokens.guardLine('10 GO', null) !== null);
  // a line editor that plants a ROM byte ($A003, the low byte of the CHROUT vector) in the line: refused
  const LEAKY = FAKE.replace('KWHIT   STA     ,Y+', 'KWHIT   LDA     $A003\n        STA     ,Y+');
  {
    const { code, json } = await probe(LEAKY);
    check('tokens: a line holding a planted ROM byte is refused, its bytes not written', code === 1 && json.results.every((r) => r.keyword === 'ZED' || r.keyword === '+') &&
      json.failed.filter((f) => /neither a token/.test(f.error)).length === 3, JSON.stringify(json));
  }

  // ---------------- mutants: each must turn a check red ----------------
  const leakRefused = (L) => { const r = traced(L, LEAK); return r.records.filter((x) => x.target === sym('CHROUT') && x.from >= 0x3000 && x.from < 0x3100 && x.regsIn.a !== 0 && x.regsIn.a !== 0xFF).length === 0; };
  const skipRefused = (L) => { const r = traced(L, CALLS); return r.records.every((x) => x.target !== sym('SKIP')) && r.refused.some((x) => x.target === sym('CHROUT') && x.refused === 'tainted-register-in'); };
  check('the real guard: the leak program and SKIP are refused', leakRefused(lib) && skipRefused(lib));
  const M = [
    ['data reads from ROM not tainted', [['if (a !== cpu.pc) stepReads.push([a, v]);', '']], (L) => leakRefused(L) && skipRefused(L)],
    ['registers ROM leaves behind not followed', [['(leftVals && leftVals[k] === regsIn[k] && leftTainted.has(k)) ||', '']], skipRefused],
    ['the tripwire off', [['return romWindowIn(Uint8Array.from(this.stream.slice(from))', 'return null && romWindowIn(Uint8Array.from(this.stream.slice(from))']],
      (L) => { const t = new L.Tripwire(STUB_IMG); t.add([...STUB.rom.subarray(0x3200, 0x3207)]); return t.add([...STUB.rom.subarray(0x3207, 0x3210)]) !== null; }],
    ['write values not checked', [['if (taint.has(w.value)) return \'tainted-write\';', '']], (L) => L.guardRecord({ regsIn: {}, regsOut: {}, ramWritesOutsideRom: [{ addr: 0x400, value: 0x55 }] }, new Set([0x55])) === 'tainted-write'],
  ];
  for (const [name, pairs, holds] of M) check(`mutant "${name}" is caught`, !holds(libWith(pairs)));
  {
    const src = fs.readFileSync(path.join(DIR, 'tokens.js'), 'utf8').replace('if (b < 0x80 && !chars.has(b))', 'if (false)');
    const file = path.join(DIR, 'tokens.js'), m = new Module(file, module);
    m.filename = file; m.paths = Module._nodeModulePaths(DIR); m._compile(src, file);
    const { code } = await probe(LEAKY, m.exports);
    check('mutant "token guard off" is caught (the planted ROM byte would be written)', code === 0);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  if (fail) { console.log(`\n${fail} check(s) failed`); process.exitCode = 1; return; }
  console.log('\nall census checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
