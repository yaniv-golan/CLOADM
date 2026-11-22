// `cloadm --assemble`: assemble to a file and stop, and the pieces under it.
//  * writeDragonDos / writeDecb (js/media/formats.js), checked against headers written out by hand and as round trips through
//    parseDragonDos / parseDecb; the gap rule (a DragonDOS file zero-fills up to 256 bytes, no more), overlap, empty, range;
//  * toBinary(result, { format }): the format is required, and each one is its writer;
//  * js/asm/symbols.js: formatSymbols / parseSymbols / lookupSymbol, with hand-written LWLINK and CMOC-style map samples;
//  * the command line: defaults from --machine, the refusals, the error codes, --map, --json, and a two-process run (assemble
//    to a file in one process, --load it with --expect-mem in another; --symbols with --disasm and --wait-for pc:LABEL);
//  * mutants: the same checks run against copies of the code with one deliberate breakage each (load and exec bytes swapped,
//    the DECB $FF $00 $00 postamble dropped, the gap rule off by one), and each copy must fail at least one check.
// Only this project's own assembler and firmware. Run: node tests/devapi-assemble.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-assemble-'));
let n = 0;
const failures = [];
const record = (label) => (name, cond, detail = '') => { if (label === 'real') n++; if (!cond) failures.push({ label, name, detail }); return cond; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a) => Array.from(a, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// the programs
const SMALL = ' ORG $3000\nSTART LDA #$41\n STA $3100\nL BRA L\n END START\n';
// two pieces with a gap between them: $3002 .. $3101 is 256 bytes, $3002 .. $3102 is 257
const gapSource = (second) => ` ORG $3000\nSTART BRA START\n ORG $${second.toString(16)}\n FCB $11,$22\n END START\n`;
const GAP256 = gapSource(0x3102), GAP257 = gapSource(0x3103);

// ---------------- the writers, the symbol maps and toBinary, against a copy of the code at `root` ----------------
async function libraryChecks(root, check) {
  const F = await import(pathToFileURL(path.join(root, 'js/media/formats.js')).href);
  const { writeDragonDos, writeDecb, WriteError, formats } = F;
  const seg = (addr, ...bytes) => ({ addr, data: Uint8Array.from(bytes) });
  const throwsKind = (fn) => { try { fn(); return null; } catch (e) { return e instanceof WriteError ? e.kind : `not a WriteError: ${e}`; } };

  // DragonDOS: $55, type, load, length, exec, $AA, the data; headers written out by hand
  check('DragonDOS: one segment is $55 02 load length exec $AA and the data', same(writeDragonDos([seg(0x3000, 1, 2, 3)], 0x3001), [0x55, 0x02, 0x30, 0x00, 0x00, 0x03, 0x30, 0x01, 0xAA, 1, 2, 3]));
  check('DragonDOS: a high load address and a different exec address stay where they belong',
    same(writeDragonDos([seg(0xC123, 9)], 0xC000), [0x55, 0x02, 0xC1, 0x23, 0x00, 0x01, 0xC0, 0x00, 0xAA, 9]));
  check('DragonDOS: type 1 is written as the type byte', writeDragonDos([seg(0x3000, 1)], 0x3000, { type: 1 })[1] === 0x01);
  check('DragonDOS: two segments are joined, in address order, whatever order they come in',
    same(writeDragonDos([seg(0x3002, 3, 4), seg(0x3000, 1, 2)], 0x3000), [0x55, 0x02, 0x30, 0x00, 0x00, 0x04, 0x30, 0x00, 0xAA, 1, 2, 3, 4]));
  const gap256 = writeDragonDos([seg(0x3000, 0xAA), seg(0x3101, 0xBB)], 0x3000);
  check('DragonDOS: the default limit is 256: a gap of exactly 256 bytes is filled with zeros', gap256.length === 9 + 0x102 && gap256[9] === 0xAA && gap256[9 + 0x101] === 0xBB && gap256.subarray(10, 9 + 0x101).every((b) => b === 0) && same(gap256.subarray(4, 6), [0x01, 0x02]));
  check('DragonDOS: a gap of 257 bytes is a WriteError of kind gap, which carries where and how big',
    throwsKind(() => writeDragonDos([seg(0x3000, 0xAA), seg(0x3102, 0xBB)], 0x3000)) === 'gap' && throwsKind(() => writeDragonDos([seg(0x3000, 0xAA), seg(0x3102, 0xBB)], 0x3000, { maxGap: 256 })) === 'gap');
  try { writeDragonDos([seg(0x3000, 0xAA), seg(0x3102, 0xBB)], 0x3000); } catch (e) { check('DragonDOS: the gap error says where the gap starts and its size', e.at === 0x3001 && e.gap === 257, `${e.at} ${e.gap}`); }
  check('DragonDOS: a larger gap is refused by default and zero-filled when the caller raises maxGap', throwsKind(() => writeDragonDos([seg(0x3000, 1), seg(0x4000, 2)], 0x3000)) === 'gap' && writeDragonDos([seg(0x3000, 1), seg(0x4000, 2)], 0x3000, { maxGap: 0xFFFF }).length === 9 + 0x1001);
  check('DragonDOS: overlapping segments are refused', throwsKind(() => writeDragonDos([seg(0x3000, 1, 2), seg(0x3001, 3)], 0x3000)) === 'overlap');
  check('DragonDOS: no segments, or only empty ones, is refused', throwsKind(() => writeDragonDos([], 0)) === 'empty' && throwsKind(() => writeDragonDos([seg(0x3000)], 0)) === 'empty');
  check('DragonDOS: an address past the 64 KiB and an exec past $FFFF are refused', throwsKind(() => writeDragonDos([seg(0xFFFF, 1, 2)], 0)) === 'range' && throwsKind(() => writeDragonDos([seg(0x3000, 1)], 0x10000)) === 'range');
  check('DragonDOS: an unknown file type is refused', throwsKind(() => writeDragonDos([seg(0x3000, 1)], 0, { type: 3 })) === 'range');

  // DECB: ($00 length address data)* then $FF $00 $00 exec
  check('DECB: one segment is $00 length address data and the $FF $00 $00 exec postamble', same(writeDecb([seg(0x3000, 1, 2, 3)], 0x3001), [0x00, 0x00, 0x03, 0x30, 0x00, 1, 2, 3, 0xFF, 0x00, 0x00, 0x30, 0x01]));
  check('DECB: segments stay separate and in the order given, gaps and all',
    same(writeDecb([seg(0x4000, 7), seg(0x3000, 5, 6)], 0x3000), [0x00, 0x00, 0x01, 0x40, 0x00, 7, 0x00, 0x00, 0x02, 0x30, 0x00, 5, 6, 0xFF, 0x00, 0x00, 0x30, 0x00]));
  check('DECB: an empty segment is left out, as DragonDOS leaves it out', same(writeDecb([seg(0x3000, 1), seg(0x3010)], 0x3000), writeDecb([seg(0x3000, 1)], 0x3000)) && same(writeDecb([seg(0x2000), seg(0x3000, 1)], 0x3000), writeDecb([seg(0x3000, 1)], 0x3000)));
  check('DECB: a program of only empty segments is the empty error, as in DragonDOS', throwsKind(() => writeDecb([seg(0x3000), seg(0x3010)], 0x3000)) === 'empty');
  check('DECB: no segments is refused, and so is a segment past the end of memory', throwsKind(() => writeDecb([], 0)) === 'empty' && throwsKind(() => writeDecb([seg(0xFFFF, 1, 2)], 0)) === 'range');

  // round trips through the parsers
  const segs = [seg(0x3000, 1, 2, 3, 4), seg(0x3010, 9, 8)];
  const dd = formats.parseDragonDos(writeDragonDos([seg(0x3000, 1, 2, 3, 4)], 0x3002));
  check('round trip: parseDragonDos(writeDragonDos(x)) gives x back, with its exec address', !!dd && dd.exec === 0x3002 && dd.segments.length === 1 && dd.segments[0].addr === 0x3000 && same(dd.segments[0].data, [1, 2, 3, 4]));
  const dd1 = formats.parseDragonDos(writeDragonDos([seg(0x3000, 1)], 0x3000, { type: 1 }));
  check('round trip: a type 1 file reads back as BASIC with no exec address', !!dd1 && dd1.basic === true && dd1.exec === null);
  const dc = formats.parseDecb(writeDecb(segs, 0x3010));
  check('round trip: parseDecb(writeDecb(x)) gives the segments back, in order, with the exec address', !!dc && dc.exec === 0x3010 && dc.segments.length === 2 && dc.segments.every((g, i) => g.addr === segs[i].addr && same(g.data, segs[i].data)));
  const bytes = writeDecb(segs, 0x3010);
  check('round trip: writeDecb(parseDecb(file)) is the same bytes', same(writeDecb(formats.parseDecb(bytes).segments, formats.parseDecb(bytes).exec), bytes));
  const ddBytes = writeDragonDos([seg(0x3000, 1, 2), seg(0x3010, 3)], 0x3000);
  const ddBack = formats.parseDragonDos(ddBytes);
  check('round trip: writeDragonDos(parseDragonDos(file)) is the same bytes', same(writeDragonDos(ddBack.segments, ddBack.exec), ddBytes));
}

async function toBinaryChecks(root, check) {
  const A = await import(pathToFileURL(path.join(root, 'js/asm/assembler.js')).href);
  const F = await import(pathToFileURL(path.join(root, 'js/media/formats.js')).href);
  const res = A.assemble(GAP256, '6809');
  check('toBinary: the example assembles in two segments', res.ok && res.segments.length === 2 && res.exec === 0x3000);
  const must = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  check('toBinary: with no format, or an unknown one, it throws and says what it needs', /format/.test(must(() => A.toBinary(res)) || '') && /format/.test(must(() => A.toBinary(res, { format: 'tape' })) || ''));
  check('toBinary: dragondos is writeDragonDos of the segments', same(A.toBinary(res, { format: 'dragondos' }), F.writeDragonDos(res.segments, res.exec)));
  check('toBinary: decb is writeDecb of the segments', same(A.toBinary(res, { format: 'decb' }), F.writeDecb(res.segments, res.exec)));
  check('toBinary: a CoCo program that is contiguous is DECB when asked for it (it used to be DragonDOS whichever machine)', A.toBinary(A.assemble(SMALL, '6809'), { format: 'decb' })[0] === 0x00);
  check('toBinary: the DragonDOS gap limit is the writer\'s default (257 refused, 256 written), and maxGap raises it', /gap/.test(must(() => A.toBinary(A.assemble(GAP257, '6809'), { format: 'dragondos' })) || '') && same(A.toBinary(res, { format: 'dragondos' }), F.writeDragonDos(res.segments, res.exec))
    && A.toBinary(A.assemble(GAP257, '6809'), { format: 'dragondos', maxGap: 4096 }).length === 9 + 0x105);
}

// ---------------- the command line, at `root` ----------------
async function cliChecks(root, check) {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  const file = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const cli = (args) => { const r = spawnSync(process.execPath, [path.join(root, 'cli/cloadm.js'), ...args], { encoding: 'utf8', cwd: dir }); return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) }; };
  const bin = (name) => Array.from(fs.readFileSync(path.join(dir, name)));
  const small = file('small.asm', SMALL), gap256 = file('gap256.asm', GAP256), gap257 = file('gap257.asm', GAP257);

  // formats from the machine
  let r = cli(['--assemble', small, '--machine', 'dragon64', '--out', 'd.bin', '--map', 'd.map']);
  check('--assemble --machine dragon64: exit 0, one line saying what was written', r.code === 0 && /small\.asm: 6809, dragondos, 16 bytes, load \$3000, exec \$3000 -> d\.bin \(2 symbols -> d\.map\)/.test(r.out), r.out + r.err);
  check('--assemble --machine dragon64: the file is a DragonDOS header by hand and the program bytes',
    same(bin('d.bin'), [0x55, 0x02, 0x30, 0x00, 0x00, 0x07, 0x30, 0x00, 0xAA, 0x86, 0x41, 0xB7, 0x31, 0x00, 0x20, 0xFE]), hex(bin('d.bin')));
  check('--map: one "NAME $ADDR" line per symbol, sorted by address', fs.readFileSync(path.join(dir, 'd.map'), 'utf8') === 'START $3000\nL $3005\n');
  r = cli(['--assemble', small, '--machine', 'coco', '--out', 'c.bin']);
  check('--assemble --machine coco: DECB by default', r.code === 0 && same(bin('c.bin'), [0x00, 0x00, 0x07, 0x30, 0x00, 0x86, 0x41, 0xB7, 0x31, 0x00, 0x20, 0xFE, 0xFF, 0x00, 0x00, 0x30, 0x00]), hex(bin('c.bin')));
  for (const [id, want] of [['dragon32', 'dragondos'], ['dragon200', 'dragondos'], ['dragon200e', 'dragondos'], ['tanodr64', 'dragondos'], ['dgnalpha', 'dragondos'], ['coco3', 'decb'], ['mx1600', 'decb'], ['cp400', 'decb']]) {
    r = cli(['--assemble', small, '--machine', id, '--out', `${id}.bin`, '--json']);
    check(`the default format of the ${id} is ${want}`, r.code === 0 && r.json().assemble.format === want, r.out + r.err);
  }
  for (const [id, name] of [['mc10', 'MC-10'], ['alice', 'Matra Alice']]) {
    for (const extra of [[], ['--format', 'raw'], ['--format', 'dragondos']]) {
      r = cli(['--assemble', small, '--machine', id, ...extra, '--out', 'm.bin']);
      check(`the ${name} loads .c10 tapes: ${extra.join(' ') || 'no --format'} is refused with the one message (and the hint that a tape is what it takes), exit 2, nothing written`,
        r.code === 2 && r.err.trim() === `cloadm: The ${name} loads .c10 tapes, not binary files: there is no file format to save a program in for it. --format cas or wav writes a tape for it.` && !fs.existsSync(path.join(dir, 'm.bin')), r.err);
    }
  }
  r = cli(['--assemble', small, '--cpu', '6803', '--format', 'raw', '--out', 'm.bin']);
  check('without a machine, a 6803 program can still be written raw', r.code === 0 && same(bin('m.bin'), [0x86, 0x41, 0xB7, 0x31, 0x00, 0x20, 0xFE]), r.err);
  r = cli(['--assemble', small, '--machine', 'dragon64', '--format', 'decb', '--out', 'x.bin']);
  check('an explicit --format wins over the machine\'s', r.code === 0 && bin('x.bin')[0] === 0x00);

  // without a machine
  r = cli(['--assemble', small, '--cpu', '6809', '--out', 'x.bin']);
  check('without --machine, --format is required: exit 2 and nothing written', r.code === 2 && /--format/.test(r.err), r.err);
  r = cli(['--assemble', small, '--format', 'raw', '--out', 'x.bin']);
  check('without --machine, --cpu is required', r.code === 2 && /--cpu/.test(r.err), r.err);
  r = cli(['--assemble', small, '--cpu', '6809', '--format', 'raw', '--out', 'r.bin']);
  check('--cpu 6809 --format raw: the bytes with no header', r.code === 0 && same(bin('r.bin'), [0x86, 0x41, 0xB7, 0x31, 0x00, 0x20, 0xFE]));

  // the gap rule
  r = cli(['--assemble', gap256, '--machine', 'dragon64', '--out', 'g256.bin']);
  const g = bin('g256.bin');
  check('a gap of 256 bytes is zero-filled in a DragonDOS file', r.code === 0 && g.length === 9 + 0x104 && same(g.slice(0, 9), [0x55, 0x02, 0x30, 0x00, 0x01, 0x04, 0x30, 0x00, 0xAA]) && g[9] === 0x20 && g[10] === 0xFE && g.slice(11, 11 + 256).every((b) => b === 0) && g[g.length - 2] === 0x11 && g[g.length - 1] === 0x22, r.err);
  r = cli(['--assemble', gap257, '--machine', 'dragon64', '--out', 'g257.bin', '--json']);
  check('a gap of 257 bytes is bad-media (exit 3) with the hint "use --format decb", and nothing is written',
    r.code === 3 && r.json().error.code === 'bad-media' && /use --format decb/.test(r.json().error.message) && !fs.existsSync(path.join(dir, 'g257.bin')), r.out + r.err);
  r = cli(['--assemble', gap257, '--machine', 'dragon64', '--format', 'decb', '--out', 'g257.bin']);
  check('the same program with --format decb is written', r.code === 0 && same(bin('g257.bin'), [0x00, 0x00, 0x02, 0x30, 0x00, 0x20, 0xFE, 0x00, 0x00, 0x02, 0x31, 0x03, 0x11, 0x22, 0xFF, 0x00, 0x00, 0x30, 0x00]), hex(bin('g257.bin')));
  r = cli(['--assemble', gap257, '--cpu', '6809', '--format', 'raw', '--out', 'x.bin']);
  check('a raw image has the same gap rule', r.code === 3 && /use --format decb/.test(r.err));

  // --json, and the errors
  r = cli(['--assemble', small, '--machine', 'dragon64', '--out', 'j.bin', '--map', 'j.map', '--json']);
  const j = r.code === 0 && r.json();
  check('--json: { ok, exit, assemble: { source, cpu, machine, format, out, size, load, exec, segments, map } }',
    j && j.ok === true && j.exit === 0 && j.assemble.cpu === '6809' && j.assemble.machine === 'dragon64' && j.assemble.format === 'dragondos' && j.assemble.out === 'j.bin' && j.assemble.size === 16
    && j.assemble.load === 0x3000 && j.assemble.exec === 0x3000 && j.assemble.segments.length === 1 && j.assemble.segments[0].address === 0x3000 && j.assemble.segments[0].length === 7
    && j.assemble.map.file === 'j.map' && j.assemble.map.symbols === 2, r.out);
  r = cli(['--assemble', file('bad.asm', ' ORG $3000\n NOSUCH #1\n END\n'), '--machine', 'coco', '--out', 'x.bin', '--json']);
  check('an assembly error is bad-media with the line, exit 3', r.code === 3 && r.json().error.code === 'bad-media' && r.json().error.errors[0].line === 2, r.out);
  r = cli(['--assemble', path.join(dir, 'nope.asm'), '--machine', 'coco', '--out', 'x.bin', '--json']);
  check('a missing source is cannot-read, exit 3', r.code === 3 && r.json().error.code === 'cannot-read');
  r = cli(['--assemble', small, '--machine', 'coco', '--out', path.join(dir, 'no', 'such', 'dir', 'x.bin'), '--json']);
  check('an unwritable --out is cannot-write, exit 3', r.code === 3 && r.json().error.code === 'cannot-write');
  r = cli(['--assemble', small, '--machine', 'coco']);
  check('--out is required', r.code === 2 && /--out/.test(r.err));
  r = cli(['--assemble', small, '--machine', 'nosuch', '--out', 'x.bin']);
  check('an unknown machine is bad-option, exit 2', r.code === 2 && /no machine/.test(r.err));
  r = cli(['--assemble', small, '--machine', 'dragon64', '--cpu', '6803', '--out', 'x.bin']);
  check('a CPU the machine does not have is refused', r.code === 2 && /6803/.test(r.err));
  r = cli(['--assemble', small, '--machine', 'coco', '--out', 'x.bin', '--frames', '3']);
  check('a step is not accepted: --assemble builds no machine', r.code === 2 && /builds no machine/.test(r.err));
  r = cli(['--assemble', file('empty.asm', ' ORG $3000\n END\n'), '--machine', 'coco', '--out', 'x.bin']);
  check('a program with no bytes is bad-media', r.code === 3 && /no bytes/.test(r.err));
  r = cli(['--assemble', small, '--machine', 'coco', '--out', 'x.bin', '--format', 'tape']);
  check('an unknown --format is refused', r.code === 2 && /dragondos, decb, raw/.test(r.err));

  // two processes: assemble to a file in one, load it in another
  const dragonRun = cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--frames', '2', '--expect-mem', '$3100=$41', '--json']);
  check('two processes: the DragonDOS file --assemble wrote loads and runs on the Dragon 64 (expect-mem $3100=$41)', dragonRun.code === 0, dragonRun.out.slice(-300) + dragonRun.err);
  const cocoRun = cli(['--machine', 'coco', '--load', path.join(dir, 'c.bin'), '--frames', '2', '--expect-mem', '$3100=$41']);
  check('two processes: the DECB file loads and runs on the CoCo', cocoRun.code === 0, cocoRun.out + cocoRun.err);
  const bigRun = cli(['--machine', 'coco', '--load', path.join(dir, 'g257.bin'), '--frames', '1', '--expect-mem', '$3103=$11', '--expect-mem', '$3104=$22']);
  check('two processes: a two-segment DECB file puts both pieces where they belong', bigRun.code === 0, bigRun.out + bigRun.err);
  const wrongRun = cli(['--machine', 'coco', '--load', path.join(dir, 'c.bin'), '--frames', '2', '--expect-mem', '$3100=$42']);
  check('two processes: the same load fails an expectation that is false (exit 1), so the checks above test something', wrongRun.code === 1);
  // the guide's own command lines, in order, in a folder with a game.asm that has the label they wait for
  const doc = fs.readFileSync(path.join(root, 'docs/automation.md'), 'utf8');
  const docDir = fs.mkdtempSync(path.join(TMP, 'doc-'));
  fs.writeFileSync(path.join(docDir, 'game.asm'), ' ORG $3000\nSTART LDA #65\n STA $3100\nLOOP BRA LOOP\n END START\n');
  const section = (doc.split('### Assemble to a file')[1] || '').split('\n### ')[0];
  const docLines = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n')).map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => /^node cli\/cloadm\.js /.test(l));
  check('the guide\'s "Assemble to a file" block has its three command lines', docLines.length === 3 && docLines.filter((l) => /--assemble/.test(l)).length === 2, docLines.join(' | '));
  for (const l of docLines) {
    const args = [...l.slice('node cli/cloadm.js '.length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
    const rr = spawnSync(process.execPath, [path.join(root, 'cli/cloadm.js'), ...args], { encoding: 'utf8', cwd: docDir });
    check(`the guide's command line runs: ${l.slice(0, 80)}`, rr.status === 0, rr.stdout + rr.stderr);
  }
  const lab = cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--symbols', path.join(dir, 'd.map'), '--wait-for', 'pc:L', '--expect-mem', '$3100=$41', '--json']);
  check('two processes: --symbols d.map then --wait-for pc:L stops at L ($3005); the label is found whatever its case', lab.code === 0 && lab.json().steps.find((s) => s.step === 'wait-for').address === 0x3005
    && cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--symbols', path.join(dir, 'd.map'), '--wait-for', 'pc:l']).code === 0, lab.out + lab.err);
  const asmDis = cli(['--asm', small, '--frames', '1', '--disasm', '$3000:3']);
  check('--disasm names the labels --asm gave, with no --symbols', asmDis.code === 0 && /START:\n\$3000 {2}86 41/.test(asmDis.out) && /\nL:\n\$3005 {2}20 FE {11}BRA \$3005 {2}; L/.test(asmDis.out), asmDis.out);
  const dis = cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--symbols', path.join(dir, 'd.map'), '--disasm', '$3000:3', '--json']);
  const ins = dis.code === 0 ? dis.json().steps.find((s) => s.step === 'disasm').instructions : [];
  check('--symbols: --disasm names the instruction at a label and the label a branch goes to', ins.length === 3 && ins[0].label === 'START' && ins[2].label === 'L' && ins[2].targetLabel === 'L', dis.out.slice(0, 400) + dis.err);
  check('--symbols: the text listing puts the label before its instruction', /START:\n\$3000 {2}86 41/.test(cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--symbols', path.join(dir, 'd.map'), '--disasm', '$3000:3']).out));
  r = cli(['--machine', 'dragon64', '--load', path.join(dir, 'd.bin'), '--wait-for', 'pc:NOWHERE']);
  check('--wait-for pc:LABEL with no such label is a usage error that says so, not a timeout', r.code === 2 && /no label NOWHERE/.test(r.err), r.err);
  r = cli(['--machine', 'dragon64', '--symbols', file('bad.map', 'START $3000\nthis is not a symbol line\n')]);
  check('--symbols with a bad map is bad-media and names the line', r.code === 3 && /line 2/.test(r.err), r.err);
  r = cli(['--machine', 'dragon64', '--symbols', path.join(dir, 'missing.map')]);
  check('--symbols with a missing file is cannot-read', r.code === 3 && /cannot read/.test(r.err));
  const desc = JSON.parse(cli(['--describe']).out);
  check('--describe lists the symbols step and the assemble mode', desc.steps.some((s) => s.name === 'symbols' && s.arg === 'FILE') && /--out/.test(desc.modes.assemble) && desc.usage.some((u) => /--assemble/.test(u)));
  check('--help names --assemble and says that --asm runs', /--assemble FILE/.test(cli(['--help']).out) && /--asm assembles and RUNS/.test(cli(['--help']).out));
}

async function symbolChecks(root, sy) {
  const S = await import(pathToFileURL(path.join(root, 'js/asm/symbols.js')).href);
  sy('symbols: formatSymbols sorts by address, then name, and writes NAME $ADDR with four digits',
    S.formatSymbols(new Map([['LOOP', 0x3005], ['START', 0x3000], ['BETA', 0x3005], ['SCREEN', 0x400]])) === 'SCREEN $0400\nSTART $3000\nBETA $3005\nLOOP $3005\n');
  sy('symbols: a value that is not a 16-bit whole number is left out', S.formatSymbols({ A: 1, B: 1.5, C: -1, D: 0x10000 }) === 'A $0001\n');
  const own = S.parseSymbols('* a comment\n; another\n# and another\n\nSTART $3000\nLOOP 0x3005\nDATA 0400\nEQ = 12\nCOL: $FF00\n');
  sy('symbols: the project\'s own format, with 0x and bare hex, = and :, comments and blank lines', own.size === 5 && own.get('START') === 0x3000 && own.get('LOOP') === 0x3005 && own.get('DATA') === 0x400 && own.get('EQ') === 0x12 && own.get('COL') === 0xFF00);
  const lw = S.parseSymbols('Section: code (game.o) load at 3000, length 0007\nSymbol: START (game.o) = 3000\nSymbol: loop (game.o) = 3005\nLocal symbol: tmp (game.o) = 0100\n');
  sy('symbols: an LWLINK map (hand-written sample: Section lines skipped, Symbol and Local symbol read)', lw.size === 3 && lw.get('START') === 0x3000 && lw.get('loop') === 0x3005 && lw.get('tmp') === 0x100);
  const cmoc = S.parseSymbols('_main 3000\n_helper = 3010\nDATA: 0400\n');
  sy('symbols: CMOC-style "name address" lines (hand-written sample)', cmoc.size === 3 && cmoc.get('_main') === 0x3000 && cmoc.get('_helper') === 0x3010 && cmoc.get('DATA') === 0x400);
  const rt = S.parseSymbols(S.formatSymbols(new Map([['A', 1], ['B', 0xFFFF], ['C', 0x1234]])));
  sy('symbols: parseSymbols(formatSymbols(x)) is x', rt.size === 3 && rt.get('A') === 1 && rt.get('B') === 0xFFFF && rt.get('C') === 0x1234);
  const bad = (text) => { try { S.parseSymbols(text); return null; } catch (e) { return e instanceof S.SymbolsError ? e : `not a SymbolsError: ${e}`; } };
  sy('symbols: a line that is not a symbol names its line number', bad('A $1\nthis is nonsense\n').line === 2);
  sy('symbols: an address past $FFFF is refused', bad('A $10000\n') instanceof S.SymbolsError);
  sy('symbols: one name with two addresses is refused, with the same address twice it is not', bad('A $1\nA $2\n').line === 2 && bad('A $1\nA $1\n') === null);
  // a name and an address need a separator: the end of a bare word is not an address
  const rejects = (text) => bad(text) instanceof S.SymbolsError;
  sy('symbols: "CODE" is not the symbol COD at $E, and "FOO1234" is not FOO123 at $4: a line with no separator is refused', rejects('CODE\n') && rejects('FOO1234\n') && rejects('ABCDEF\n') && rejects('X$12\n'));
  sy('symbols: a separator may be white space, "=" or ":", with or without spaces around the last two', ['A 12', 'A\t12', 'A=12', 'A = 12', 'A: 12', 'A:12', 'A $12', 'A 0x12'].every((l) => { const m = S.parseSymbols(`${l}\n`); return m.size === 1 && m.get('A') === 0x12; }));
  const lower = S.parseSymbols('foo c0de\nSymbol: x (f.o) = 00ff\nbar = 0xabcd\nbaz: $fF00\n');
  sy('symbols: hexadecimal addresses in lower case (and mixed), in the plain form, LWLINK\'s and after 0x or $', lower.get('foo') === 0xC0DE && lower.get('x') === 0xFF && lower.get('bar') === 0xABCD && lower.get('baz') === 0xFF00);
  sy('symbols: lookupSymbol finds an exact name, then a case-insensitive one if only one matches, and gives up on a tie',
    S.lookupSymbol(new Map([['Loop', 5]]), 'Loop') === 5 && S.lookupSymbol(new Map([['LOOP', 5]]), 'loop') === 5 && S.lookupSymbol(new Map([['LOOP', 5], ['Loop', 6]]), 'loop') === undefined && S.lookupSymbol(null, 'x') === undefined);
}

(async () => {
  // the real code first: every check must hold
  const real = record('real');
  await libraryChecks(ROOT, real);
  await toBinaryChecks(ROOT, real);
  await cliChecks(ROOT, real);

  const Emu = await import(pathToFileURL(path.join(ROOT, 'js/emu.js')).href);
  const sy = record('real');
  await symbolChecks(ROOT, sy);
  sy('binaryFormat: dragondos for every Dragon, decb for every CoCo, none for the MC-10 and the Alice', (() => {
    const dragons = ['dragon32', 'dragon64', 'dragon200', 'dragon200e', 'tanodr64', 'dgnalpha', 'd64plus'], cocos = ['coco', 'coco2b', 'mx1600', 'lzcolor64', 'cd6809', 'cp400', 'coco3', 'coco3p'];
    return dragons.every((id) => Emu.binaryFormat(Emu.profiles[id]) === 'dragondos') && cocos.every((id) => Emu.binaryFormat(Emu.profiles[id]) === 'decb') && Emu.binaryFormat(Emu.profiles.mc10) === null && Emu.binaryFormat(Emu.profiles.alice) === null
      && Object.keys(Emu.profiles).every((id) => [...dragons, ...cocos, 'mc10', 'alice'].includes(id));
  })());

  // the mutants: a copy of the code with one breakage each; each must fail some check
  const mutants = [   // [what, from, to, file (default js/media/formats.js)]
    ['the load and exec bytes swapped in the DragonDOS header', 'out.set([0x55, type, ...word(lo), ...word(len), ...word(exec), 0xAA]);', 'out.set([0x55, type, ...word(exec), ...word(len), ...word(lo), 0xAA]);'],
    ['the DECB $FF $00 $00 postamble dropped', 'parts.push(0xFF, 0x00, 0x00, ...word(exec));', 'parts.push(...word(exec));'],
    ['the gap rule off by one (a gap of exactly the limit refused)', 'g.addr - end > maxGap', 'g.addr - end >= maxGap'],
    ['the gap rule off by one the other way (a gap one over the limit allowed)', 'g.addr - end > maxGap', 'g.addr - end > maxGap + 1'],
    ['an empty segment written as a DECB block', 'const kept = segments.filter((g) => g.data.length); ', 'const kept = segments; '],
    ['the default gap limit unlimited again', 'maxGap = 256 }', 'maxGap = 0xFFFF }'],
    ['symbols: no separator required', "(?:\\\\s*[=:]\\\\s*|\\\\s+)", "\\\\s*(?:=|:)?\\\\s*", 'js/asm/symbols.js'],
    ['symbols: upper-case hexadecimal only', '[0-9A-Fa-f]{1,5}', '[0-9A-F]{1,5}', 'js/asm/symbols.js'],
  ];
  const copies = [];
  for (const [what, from, to, file = 'js/media/formats.js'] of mutants) {
    const root = fs.mkdtempSync(path.join(TMP, 'mutant-'));
    for (const d of ['js', 'cli']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
    const f = path.join(root, file), text = fs.readFileSync(f, 'utf8');
    if (text.split(from).length !== 2) { record('mutant')(`the mutation "${what}" applies exactly once (the code it breaks has moved)`, false); continue; }
    fs.writeFileSync(f, text.replace(from, to));
    copies.push({ what, root });
  }
  const mutantResults = [];
  // a breakage may make a parser give up (null) where a check expects a value: that is the check failing, not the test crashing
  const guarded = async (fn, root, check) => { try { await fn(root, check); } catch (e) { check(`a check threw: ${e.message}`, false); } };
  for (const { what, root } of copies) {
    const before = failures.length;
    const m = record(`mutant: ${what}`);
    await guarded(libraryChecks, root, m);
    await guarded(symbolChecks, root, m);
    await guarded(toBinaryChecks, root, m);
    await guarded(cliChecks, root, m);
    const red = failures.splice(before).map((x) => x.name);
    mutantResults.push({ what, red });
  }

  const realFails = failures.filter((x) => x.label !== 'mutant');
  let bad2 = 0;
  for (const x of realFails) { bad2++; console.log(`FAIL ${x.name} ${x.detail}`); }
  for (const x of failures.filter((y) => y.label === 'mutant')) { bad2++; console.log(`FAIL ${x.name}`); }
  for (const { what, red } of mutantResults) {
    const ok = red.length > 0;
    if (!ok) bad2++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} mutant (${what}) turns ${red.length} check${red.length === 1 ? '' : 's'} red${red.length ? `, first: ${red[0]}` : ''}`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(bad2 ? `${bad2} FAILED` : `${n}/${n} assemble checks passed`);
  process.exitCode = bad2 ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
