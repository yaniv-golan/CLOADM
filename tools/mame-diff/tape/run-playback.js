// How .CAS files are played: MAME and our machine play the same images (spec.js playbackTapes) to two firmwares
// of ours installed as the BASIC ROM, and the tables they leave must agree (spec.js PLAYBACK says how):
//   gaps.asm    the silences in the signal (where, and how long)
//   cloadm.asm  the blocks a CLOADM-style reader finds, with BASIC's half-second wait after the motor starts
//   node tools/mame-diff/tape/run-playback.js [profile ...]   (default dragon64 coco)
//   --ours   our machine only, printing the tables
const fs = require('fs'), path = require('path');
const { loadEmu, assembleFile, romImage, writeRoms, mameConfigArgs } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir } = require('../lib/workdir');
const { playbackTapes, PLAYBACK, playbackTable } = require('./spec.js');
const Emu = loadEmu();

const args = process.argv.slice(2), oursOnly = args.includes('--ours');
const ids = args.filter((a) => !a.startsWith('--'));
let fail = 0;

for (const id of ids.length ? ids : ['dragon64', 'coco']) {
  const p = Emu.profiles[id], base = Math.min(...p.roms.map((s) => s.at)), end = Math.max(...p.roms.map((s) => s.at + s.size));
  const work = workDir(`${id}-playback`);
  for (const [kind, k] of Object.entries(PLAYBACK)) {
    const asm = assembleFile(path.join(__dirname, k.file), '6809'), haltPc = asm.symbols.get('HALT');
    const img = romImage(asm, base, end - base, 0x12), slots = {}, files = {};
    for (const sl of p.roms) slots[sl.id] = img.slice(sl.at - base, sl.at - base + sl.size);
    for (const sl of p.roms) for (const f of sl.files) files[f] = slots[sl.id];
    for (const [name, bytes] of Object.entries(playbackTapes())) {
      const ours = playbackTable(kind, id, slots, bytes);
      if (oursOnly) { console.log(`${id} ${kind} ${name}: ${ours ? k.show(ours) : '(did not reach HALT)'}`); continue; }
      const dir = path.join(work, `${kind}-${name}`);
      writeRoms(dir, p.mame, files);
      const cas = path.join(dir, `${name}.cas`), out = path.join(dir, 'table.txt');
      fs.writeFileSync(cas, bytes);
      // the table once the firmware has sat in its BRA * for three frames (MAME may report its PC at the opcode,
      // the operand or past it: run-tape.js)
      const lua = `
local cpu = manager.machine.devices[':maincpu']
local sp = cpu.spaces['program']
for tag, c in pairs(manager.machine.cassettes) do c:play() end
local prev, streak = nil, 0
emu.register_frame_done(function()
  local pc = cpu.state['PC'].value
  local at = (pc >= ${haltPc} and pc <= ${haltPc} + 2)
  if at and prev == pc then streak = streak + 1 else streak = at and 1 or 0 end
  prev = at and pc or nil
  if streak >= 3 then
    local f = io.open('${out}', 'w')
    for a = 0x1000, cpu.state['U'].value - 1 do f:write(string.format('%02x', sp:read_u8(a))) end
    f:close()
    manager.machine:exit()
  end
end)`;
      runMame({ work: dir, system: p.mame, seconds: k.seconds, args: ['-ext', '', ...mameConfigArgs({}), '-cass', cas], lua });
      const mame = fs.existsSync(out) ? k.parse(Buffer.from(fs.readFileSync(out, 'utf8'), 'hex')) : null;
      const ok = !!(mame && ours && k.same(mame, ours));
      if (!ok) fail++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} ${kind} ${name}: ${k.what} ${ok ? 'identical with' : 'differ from'} MAME's`);
      console.log(`       MAME: ${mame ? k.show(mame) : '(did not reach HALT)'}`);
      console.log(`       ours: ${ours ? k.show(ours) : '(did not reach HALT)'}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
}
if (!oursOnly) console.log(fail ? `${fail} FAILED` : 'tape playback identical with MAME');
process.exitCode = fail ? 1 : 0;
