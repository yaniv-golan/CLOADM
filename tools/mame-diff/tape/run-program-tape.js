#!/usr/bin/env node
// The BASIC program as a tape (Session.programTape: Share's "Download .CAS" / "Download .WAV") read by MAME, with our own
// reader firmware in place of the BASIC ROM (cload.asm, cload6803.asm: no ROM anywhere). The program is made on our
// stand-in BASIC (tests/fixtures/basic-standin.js), padded with REM lines to exactly 255 tokenised bytes, which is one
// data block: the reader then reports 255 bytes, their 16-bit sum, 3 blocks (namefile, data, EOF) and no bad checksum,
// in MAME and on our machine. The .CAS (.C10 on the MC-10) and the WAV are both read.
// (A real BASIC ROM's CLOAD of the same tape needs a ROM, so it is a maintainer's manual step: docs/verification.md.)
//   node tools/mame-diff/tape/run-program-tape.js [profile ...]     (default: dragon64 coco mc10)
const fs = require('fs'), path = require('path');
const { firmware } = require('./spec');
const { haltLua } = require('./halt');
const { loadEmu, writeRoms, mameConfigArgs } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir } = require('../lib/workdir');
const { build } = require('../../../tests/fixtures/basic-standin');

const Emu = loadEmu();
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['dragon64', 'coco', 'mc10']) {
  const mc10 = Emu.profiles[id].family === 'mc10';
  // the program, on our stand-in BASIC at OK: REM lines (60 characters at most: the MC-10 takes 128 a line) until the
  // tokenised program is exactly 255 bytes
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  for (const [k, v] of Object.entries(build(Emu, id))) s.roms.put(id, k, v, `${k}.rom`);
  s.switchMachine(id, undefined, { menu: false });
  for (let i = 0; i < 600 && s.bootStatus().state !== 'ok'; i++) s.runFrames(1);
  const text = (k) => `10 PRINT "TAPE"\n20 REM ${'X'.repeat(60)}\n30 REM ${'Y'.repeat(60)}\n40 REM ${'Z'.repeat(60)}\n50 REM ${'W'.repeat(k)}\n60 GOTO 10`;
  let n = 20, data = null;
  for (let k = 0; k < 50; k++) { s.loadBasic(text(n)); data = s.basicProgramBytes(); if (data.length === 255) break; n += 255 - data.length; }
  if (!data || data.length !== 255) { check(`${id}: a 255-byte program`, false, `${data && data.length} bytes`); continue; }
  const sum = data.reduce((a, b) => (a + b) & 0xFFFF, 0);
  const want = mc10 ? `X=255 A:B=${sum} NBLK=3 NBAD=0` : `X=255 Y=${sum} U=3 B=0`;
  const r = firmware(id, mc10 ? 'cload6803.asm' : 'cload.asm');
  const config = mc10 ? { ram: 4 } : {};
  const work = workDir(`${id}-program-tape`);
  for (const wav of [false, true]) {
    const t = s.programTape('MAMETEST', { wav });
    const dir = path.join(work, t.name.replace('.', '-'));
    writeRoms(dir, r.system, r.files);
    const file = path.join(dir, t.name.toLowerCase()), out = path.join(dir, 'regs.txt');
    fs.writeFileSync(file, t.bytes);
    // (MAME's MC-10 puts 15 s of silence before every .CAS block: run-tape.js says why 70 s)
    runMame({ work: dir, system: r.system, seconds: mc10 && !wav ? 70 : 30, args: ['-ext', '', ...mameConfigArgs(config), '-cass', file], lua: haltLua(r.haltPc, out, mc10) });
    const got = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(did not reach HALT)';
    check(`${id}: MAME reads ${t.name} (Session.programTape, 255 program bytes, sum ${sum}) with ${mc10 ? 'cload6803.asm' : 'cload.asm'}`, got === want, got);
    // the same file on our machine, as Session.insertTape takes it
    const om = r.machine(config), d = Emu.formats.identify(t.name, t.bytes);
    om.deck.insert(new Emu.Tape(d.bytes, om.tickHz, t.name, om.profile.tape));
    for (let fr = 0; fr < 50 * 40 && om.cpu.pc !== r.haltPc; fr++) om.runFrame();
    const c = om.cpu;
    const mine = om.cpu.pc === r.haltPc ? (mc10
      ? `X=${c.x} A:B=${c.a | (c.b << 8)} NBLK=${(c.iram[8] << 8) | c.iram[9]} NBAD=${(c.iram[10] << 8) | c.iram[11]}`
      : `X=${c.x} Y=${c.y} U=${c.u} B=${c.b}`) : '(did not reach HALT)';
    check(`${id}: our machine reads ${t.name} the same`, mine === want, mine);
  }
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(fail ? `${fail} FAILED` : 'program tapes: MAME reads them as our machine does');
process.exitCode = fail ? 1 : 0;
