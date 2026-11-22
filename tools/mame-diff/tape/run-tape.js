#!/usr/bin/env node
// Cassette comparison with MAME, with our own firmware in place of the BASIC ROM:
//  1. csave: MAME runs the writer and records its cassette output to a WAV; that WAV, decoded by
//     js/media/cassette.js, must be exactly the byte stream the firmware writes (tape/spec.js csaveStream).
//  2. cload: MAME reads files we export with the reader: the .CAS and WAV we capture from our machine running
//     the writer, and the WAV we export from that .CAS (Session.tapeWav's path). Every one must read back
//     3 blocks, 255 data bytes with their sum, and no bad checksum, in MAME as on our machine. Also the WAVs buildCas and casToWav make
//     for the same program (a sine and a square wave, with a player's gaps).
// Two firmware pairs: the Dragon/CoCo 6809 pair (csave.asm/cload.asm) and the MC-10 6803 pair
// (csave6803.asm/cload6803.asm), which reports its counts in memory (the 6803 has one 16-bit register).
//   node tools/mame-diff/tape/run-tape.js [profile ...]     (default: dragon64 coco mc10)
const fs = require('fs'), path = require('path');
const { firmware, csaveStream } = require('./spec');
const { loadEmu, writeRoms, mameConfigArgs } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir } = require('../lib/workdir');

const Emu = loadEmu();
const expected = csaveStream();
const dataSum = [...Array(255).keys()].reduce((s, i) => (s + ((11 + 37 * i) & 0xFF)) & 0xFFFF, 0);
const want = `X=255 Y=${dataSum} U=3 B=0`;
const want6803 = `X=255 A:B=${dataSum} NBLK=3 NBAD=0`;
const is6803 = (id) => Emu.profiles[id].family === 'mc10';
const pair = (id) => (is6803(id) ? { save: 'csave6803.asm', load: 'cload6803.asm' } : { save: 'csave.asm', load: 'cload.asm' });
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

// Registers in HALT, written by a Lua frame callback, then MAME exits. The 6803 has A, B, X only: the block
// count and bad checksums are 16-bit words in memory, high byte first, at $0088 and $008A.
//
// The halt test used to be `pc >= haltPc && pc <= haltPc + 2`, to allow for MAME leaving the PC up to two bytes
// into the `BRA *` when a frame callback runs. That window is wrong: haltPc+2 is a real instruction in every one
// of these firmwares - it is the entry of LEADER in the two writers and of RDBYTE in the two readers - so a
// frame that happened to land on a JSR to that subroutine counted as a halt, mid-tape. It reported whatever the
// registers and counters held at that moment, which is how the MC-10 .cas case came to look like "no signal
// reaches the machine". The halt is now three conditions together:
//   1. pc is haltPc, haltPc+1 or haltPc+2. All three are readings MAME gives for `BRA *`: it can catch the CPU
//      with the PC at the opcode, at the operand, or past the whole instruction. haltPc+1 is safe to accept and
//      haltPc+2 is not, and the difference matters: haltPc+1 is the operand byte, where no instruction can start,
//      while haltPc+2 is the first byte of the NEXT instruction - the entry of LEADER or RDBYTE. That is why
//      condition 3, not the address, has to carry the weight.
//   2. the opcode at haltPc is really $20 $FE (`BRA *`), not because we assumed it;
//   3. pc is the SAME value on three consecutive frame callbacks.
// Condition 3 is the one that does the work: at a real halt the CPU never leaves `BRA *`, so pc is identical
// on every frame. At RDBYTE entry pc equals haltPc+2 for the ~112 us the subroutine takes - about half a
// percent of a frame - so catching it on three frames in a row does not happen, while a single stray frame
// could. Two frames would also be enough in principle but leave less margin, and the check costs nothing.
const HALT_FRAMES = 3;
const haltLua = (haltPc, out, is6803) => `
local cpu = manager.machine.devices[':maincpu']
local space = cpu.spaces['program']
for tag, c in pairs(manager.machine.cassettes) do c:play() end
local op1, op2 = space:read_u8(${haltPc}), space:read_u8(${haltPc} + 1)
local bra = (op1 == 0x20 and op2 == 0xFE)
local prev, streak = nil, 0
emu.register_frame_done(function()
  local pc = cpu.state['PC'].value
  local at = bra and (pc == ${haltPc} or pc == ${haltPc} + 1 or pc == ${haltPc} + 2)
  if at and prev == pc then streak = streak + 1 else streak = at and 1 or 0 end
  prev = at and pc or nil   -- only a run of consecutive frames at one halt address counts
  if streak >= ${HALT_FRAMES} then
    local f = io.open('${out}', 'w')
    ${is6803 ? `
    local s = cpu.state
    -- the reader reports the 16-bit sum with A the low byte, so the printed value is A | B << 8; the two counters
    -- at $0088/$008A are 16-bit words in memory, high byte first (the 6803's big-endian order)
    f:write(string.format('X=%d A:B=%d NBLK=%d NBAD=%d', s['X'].value, s['A'].value | (s['B'].value << 8),
      (space:read_u8(0x88) << 8) | space:read_u8(0x89), (space:read_u8(0x8A) << 8) | space:read_u8(0x8B)))` : `
    f:write(string.format('X=%d Y=%d U=%d B=%d', cpu.state['X'].value, cpu.state['Y'].value, cpu.state['U'].value, cpu.state['B'].value))`}
    f:close()
    manager.machine:exit()
  end
end)
`;

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['dragon64', 'coco', 'mc10']) {
  const f = pair(id), mc10 = is6803(id);
  const wantLine = mc10 ? want6803 : want;
  // the MC-10 always has the base 4K; run the 6809 profiles with their defaults
  const config = mc10 ? { ram: 4 } : {};
  const work = workDir(`${id}-tape`);
  // 1. MAME records what the writer writes
  const w = firmware(id, f.save);
  writeRoms(path.join(work, 'csave'), w.system, w.files);
  const rec = path.join(work, 'mame-csave.wav');
  runMame({ work: path.join(work, 'csave'), system: w.system, seconds: 8, args: ['-ext', '', ...mameConfigArgs(config), '-cass', rec],
    lua: 'for tag, c in pairs(manager.machine.cassettes) do c:record() end' });
  const fromMame = fs.existsSync(rec) && fs.statSync(rec).size > 44 ? Emu.wavToCas(fs.readFileSync(rec)) : null;
  check(`${id}: MAME's recording of ${f.save} decodes to the bytes written`, !!fromMame && Buffer.from(fromMame.bytes).equals(Buffer.from(expected)),
    fromMame ? `(${fromMame.bytes.length} of ${expected.length} bytes, ${fromMame.blocks} blocks)` : '(no recording)');

  // our capture of the same firmware, and the files we export from it
  const m = w.machine(config);
  m.deck.startRecording();
  for (let fr = 0; fr < 50 * 40 && m.cpu.pc !== w.haltPc; fr++) m.runFrame();
  const samples = Emu.recordingToSamples(m.deck.stopRecording(), m.tickHz, 44100);
  const ours = Emu.samplesToCas(samples, 44100);
  check(`${id}: our capture of ${f.save} decodes to the bytes written`, Buffer.from(ours.bytes).equals(Buffer.from(expected)));
  // and the tape buildCas writes for the same program (CLOADM, load and exec $3000, the 255 bytes csave.asm writes) as a WAV a player
  // would play: a sine and a square wave, with the player's gaps (casToWav)
  const family = mc10 ? 'mc10' : 'dragon';
  const built = Emu.buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data: Array.from({ length: 255 }, (_, i) => (11 + 37 * i) & 0xFF) }], { family });
  check(`${id}: buildCas writes exactly the stream ${f.save} writes`, Buffer.from(built).equals(Buffer.from(expected)));
  const exports = {
    'captured.cas': ours.bytes,
    'captured.wav': Emu.writeWav(samples, 44100),
    'exported.wav': Emu.casToWav(ours.bytes),
    'built.wav': Emu.casToWav(built, { family }),
    'built-square.wav': Emu.casToWav(built, { family, wave: 'square' }),
  };

  // 2. MAME (and our machine) read them with the reader
  const r = firmware(id, f.load);
  for (const [name, bytes] of Object.entries(exports)) {
    const dir = path.join(work, name.replace('.', '-'));
    writeRoms(dir, r.system, r.files);
    const file = path.join(dir, name), out = path.join(dir, 'regs.txt');
    fs.writeFileSync(file, bytes);
    // MAME's mc10 and alice load a .cas with the alice32 variant of the CoCo format, which puts 15 s of
    // silence before every block (src/lib/formats/coco_cas.cpp:46, applied at :205-217). Our 669-byte capture
    // is a 50.3 s tape there - 15 s header, 15 s before block 1, 15 s more before block 2 - so a 30 s run
    // cannot reach the data at all, and used to "finish" early on the halt test's false positive instead.
    // 70 s leaves room for the reader's own bit timing (it halts at ~36 s). The WAV files are the same signal
    // without that padding and finish in seconds.
    const seconds = mc10 && name.endsWith('.cas') ? 70 : 30;
    runMame({ work: dir, system: r.system, seconds, args: ['-ext', '', ...mameConfigArgs(config), '-cass', file], lua: haltLua(r.haltPc, out, mc10) });
    const got = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(did not reach HALT)';
    check(`${id}: MAME reads our ${name} with ${f.load}`, got === wantLine, got);
    // the same file on our machine: a WAV goes through the decoder, as Session.insertTape does
    const om = r.machine(config), d = Emu.formats.identify(name, bytes);
    om.deck.insert(new Emu.Tape(d.bytes, om.tickHz, name, om.profile.tape));
    for (let fr = 0; fr < 50 * 40 && om.cpu.pc !== r.haltPc; fr++) om.runFrame();
    const c = om.cpu;
    // the same convention as the Lua above: A is the sum's low byte, so A | B << 8, and the counters are
    // 16-bit, high byte first
    const mine = om.cpu.pc === r.haltPc ? (mc10
      ? `X=${c.x} A:B=${c.a | (c.b << 8)} NBLK=${(c.iram[8] << 8) | c.iram[9]} NBAD=${(c.iram[10] << 8) | c.iram[11]}`
      : `X=${c.x} Y=${c.y} U=${c.u} B=${c.b}`) : '(did not reach HALT)';
    check(`${id}: our machine reads our ${name} with ${f.load}, as MAME does`, mine === wantLine, mine);
  }
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(fail ? `${fail} FAILED` : 'tape comparison with MAME passed');
process.exitCode = fail ? 1 : 0;
