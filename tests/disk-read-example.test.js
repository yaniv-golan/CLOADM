// The disk-read example (docs/examples/disk-read.mjs, docs/examples/diskread.asm) and the guide's section "Reading a disk with no
// DOS ROM", run so they cannot rot:
//  * the example runs from a temporary directory outside the repository, and from a copy of the .mjs alone with CLOADM_DIR, checks
//    its own results, prints the numbers the guide quotes, and prints the same on every run;
//  * an independent run in this test: a VDK built by hand (the header and sector offsets written out here, not taken from the
//    example), a different pattern, the same guest; RAM must hold the sectors the guest asked for;
//  * three mutants of the guest (the wrong sector-length bit, one byte too few, no seek) each make the example fail;
//  * what the guide says about the command line is what it does: with no ROMs `--disk` stops with exit 3 and "Disks need a disk
//    ROM", in either order of the steps;
//  * the guide's links and anchors resolve.
// Only this project's own assembler and firmware, and a disk built here. Run: node tests/disk-read-example.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-diskread-'));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', cwd: TMP }, opts));

(async () => {
  const doc = read('docs/automation.md');
  const exampleDir = path.join(ROOT, 'docs/examples'), example = path.join(exampleDir, 'disk-read.mjs');
  const run = (file, env = {}) => node([file], { env: Object.assign({}, process.env, env) });
  const parse = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; } };

  // ---------------- the example ----------------
  const r1 = run(example), j1 = parse(r1);
  check('the example runs from a directory outside the repository and checks its own results', r1.status === 0 && !!j1 && path.relative(ROOT, TMP).startsWith('..'), r1.stderr + r1.stdout);
  check('it read track 0 sector 1 into $3200 and track 2 sector 5 into $3300, 256 bytes each, matching, with a clean status',
    !!j1 && j1.reads.length === 2 && j1.reads[0].track === 0 && j1.reads[0].sector === 1 && j1.reads[0].at === '$3200' && j1.reads[1].track === 2 && j1.reads[1].sector === 5 && j1.reads[1].at === '$3300'
    && j1.reads.every((r) => r.bytes === 256 && r.match === true && r.status === '$00'), JSON.stringify(j1));
  check('it reports elapsed frames and CPU cycles, and the cycles fit the frames (a Dragon frame is 17,784 cycles)', !!j1 && j1.frames > 0 && j1.cycles > j1.frames * 17000 && j1.cycles < (j1.frames + 1) * 17800, JSON.stringify(j1 && [j1.frames, j1.cycles]));
  const r2 = run(example);
  check('a second run prints exactly the same (emulated time only)', r2.status === 0 && r2.stdout === r1.stdout);
  {
    const quoted = [...doc.matchAll(/```json\n(\{"reads":[^\n]*\})\n```/g)].map((m) => JSON.parse(m[1]));
    check('the guide quotes exactly what the example prints (every field)', quoted.length === 1 && !!j1 && JSON.stringify(quoted[0]) === JSON.stringify(j1), `${JSON.stringify(quoted[0])} vs ${JSON.stringify(j1)}`);
  }
  const copy = path.join(TMP, 'copy');
  fs.mkdirSync(copy);
  fs.copyFileSync(example, path.join(copy, 'disk-read.mjs'));
  const r3 = run(path.join(copy, 'disk-read.mjs'), { CLOADM_DIR: ROOT });
  check('a copy of the .mjs alone, outside the repository, runs with CLOADM_DIR and prints the same', r3.status === 0 && r3.stdout === r1.stdout, r3.stderr);

  // ---------------- an independent run: a disk written out by hand ----------------
  const Emu = await import(pathToFileURL(path.join(ROOT, 'js/emu.js')).href);
  {
    // a VDK is a 12-byte header and then, track by track, 18 sectors of 256 bytes numbered from 1 (single sided here): written out
    // here from the format, and not through diskGeometry; the pattern is not the example's
    const HEADER = 12, TRACKS = 40, SPT = 18;
    const byteAt = (t, s, i) => ((t + 1) * 131 + (s + 1) * 17 + i * 3 + (i >> 5)) & 0xFF;
    const image = Emu.blankDisk('vdk', TRACKS, 1);
    check('a blank 40-track VDK is the 12-byte header and 40 x 18 x 256 bytes', image.length === HEADER + TRACKS * SPT * 256 && image[0] === 0x64 && image[1] === 0x6B, String(image.length));
    for (let t = 0; t < TRACKS; t++) for (let s = 1; s <= SPT; s++) for (let i = 0; i < 256; i++) image[HEADER + (t * SPT + (s - 1)) * 256 + i] = byteAt(t, s, i);
    const session = new Emu.Session({ welcomeMenu: false });
    session.switchMachine('dragon64', {}, { menu: false });
    const m = session.machine, fdc = new Emu.devices.dragonfdc();
    m.insertCartridge(fdc);
    fdc.mount(0, { bytes: image, format: 'vdk', name: 'by-hand.vdk' });
    const res = Emu.assemble(read('docs/examples/diskread.asm'), '6809');
    check('diskread.asm assembles', res.ok, JSON.stringify(res.errors));
    session.runAssembled(res);
    for (let f = 0; f < 600 && session.readByte(0x3100) !== 0xA5; f++) session.runFrames(1);
    check('the guest finishes (done byte $A5)', session.readByte(0x3100) === 0xA5);
    const ram = (at) => Array.from({ length: 256 }, (_, i) => session.readByte(at + i));
    const want = (t, s) => Array.from({ length: 256 }, (_, i) => byteAt(t, s, i));
    check('RAM $3200 holds track 0 sector 1 of the disk as written by hand', ram(0x3200).every((b, i) => b === want(0, 1)[i]));
    check('RAM $3300 holds track 2 sector 5 (the seek happened: track 0 sector 5 and track 2 sector 1 differ)', ram(0x3300).every((b, i) => b === want(2, 5)[i]) && !ram(0x3300).every((b, i) => b === want(0, 5)[i]) && !ram(0x3200).every((b, i) => b === want(2, 1)[i]));
    check('the controller\'s status after both reads has no error bit, and the guest stopped writing 256 bytes after each start',
      (session.readByte(0x3101) & 0x9D) === 0 && (session.readByte(0x3102) & 0x9D) === 0 && ((session.readByte(0x3104) << 8) | session.readByte(0x3105)) === 0x3300 && ((session.readByte(0x3106) << 8) | session.readByte(0x3107)) === 0x3400);
    check('the controller is the one in the cartridge port, with no ROM: the cartridge space reads 00, and the disk is in drive 0', fdc.rom() === null && m.read(0xC000) === 0x00 && fdc.drives[0].loaded);
  }

  // ---------------- mutants of the guest ----------------
  const mutant = (name, from, to) => {
    const root = path.join(TMP, name), dir = path.join(root, 'docs/examples');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'js'), path.join(root, 'js'), 'dir');
    fs.symlinkSync(path.join(ROOT, 'cli'), path.join(root, 'cli'), 'dir');
    const asm = fs.readFileSync(path.join(exampleDir, 'diskread.asm'), 'utf8');
    if (asm.split(from).length !== 2) throw new Error(`mutant ${name}: the text to change is not there exactly once`);
    fs.writeFileSync(path.join(dir, 'diskread.asm'), asm.replace(from, to));
    fs.copyFileSync(example, path.join(dir, 'disk-read.mjs'));
    return run(path.join(dir, 'disk-read.mjs'));
  };
  const why = (r) => r.stderr.split('\n').find((l) => /^Error: disk-read:/.test(l)) || r.stderr.split('\n')[0];
  const wrongBit = mutant('wrongbit', 'CMDREAD EQU     $88', 'CMDREAD EQU     $80');
  check('the wrong sector-length bit (read command $80: code 1 means 512 bytes) makes the example fail', wrongBit.status !== 0 && /disk-read: track 0 sector 1: the controller's status is/.test(wrongBit.stderr), why(wrongBit));
  const oneShort = mutant('oneshort', '        LDB     #0 ', '        LDB     #255');
  check('a guest that takes one byte too few makes the example fail', oneShort.status !== 0 && /disk-read: track 0 sector 1: the guest took 255 bytes, not 256/.test(oneShort.stderr), why(oneShort));
  const noSeek = mutant('noseek', '        STA     FDCCMD          ; the seek', '        NOP');
  check('a guest that never seeks (it reads sector 5 of track 0) makes the example fail', noSeek.status !== 0 && /disk-read: track 2 sector 5: byte \d+ is/.test(noSeek.stderr), why(noSeek));

  // ---------------- the command line, as the guide says ----------------
  {
    const dir = path.join(TMP, 'cli');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 't.vdk'), Emu.blankDisk('vdk', 40, 1));
    const asm = path.join(exampleDir, 'diskread.asm'), cli = (args) => node([path.join(ROOT, 'cli/cloadm.js'), ...args], { cwd: dir });
    for (const [label, args] of [['--disk then --asm', ['--disk', 't.vdk', '--asm', asm, '--frames', '2']], ['--asm then --disk', ['--asm', asm, '--disk', 't.vdk', '--frames', '2']], ['--no-roms --disk', ['--no-roms', '--disk', 't.vdk', '--info']]]) {
      const r = cli(args);
      check(`the command line with no ROMs, ${label}: exit 3 and "Disks need a disk ROM" (the guide says so)`, r.status === 3 && /Disks need a disk ROM/.test(r.stderr), r.stderr);
    }
  }

  // ---------------- the guide ----------------
  const heading = '### Reading a disk with no DOS ROM', anchor = '#reading-a-disk-with-no-dos-rom';
  check('the guide has the section, and its anchor is its heading', doc.includes(heading));
  check('the Dragon 64 row of the machine notes and the game guide link to it', read('docs/machines.md').includes(`automation.md${anchor}`) && read('docs/game-development.md').includes(`automation.md${anchor}`));
  check('the section names the example, the guest and this test, and they exist', ['docs/examples/disk-read.mjs', 'docs/examples/diskread.asm', 'tests/disk-read-example.test.js'].every((f) => doc.includes(f) && fs.existsSync(path.join(ROOT, f))));
  const section = doc.slice(doc.indexOf(heading)).split('\n### ')[0];
  check('the section says the command line does not do this today, and says why', /does not work today/.test(section) && /Disks need a disk ROM/.test(section));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} disk-read checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
