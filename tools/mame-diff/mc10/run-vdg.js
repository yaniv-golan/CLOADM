// Compare the MC-10's rendered video against MAME: node tools/mame-diff/mc10/run-vdg.js
// Runs vdg.asm (our own firmware) on both emulators, captures every display mode and compares the
// 256x192 active area pixel by pixel (MAME's palette is matched to ours one to one, by majority vote).
// Composite colour (NTSC artifact colours in the 256x192 mode) is compared exactly too, with MAME's
// "Artifacting" option and ours set alike: ARTIFACT=N (0 off, 1 Standard, 2 Reverse; default 1, MAME's).
const fs = require('fs'), path = require('path');
const Emu = require('../../../tests/load.js')();
const VDGC = Emu.MC6847;
const { workDir } = require('../lib/workdir');
// VDG_WORK: a folder of your own, kept (and needed by SKIP_MAME=1); otherwise a fresh one, removed at exit
const WORK = process.env.VDG_WORK || workDir('mc10-vdg');
if (process.env.SKIP_MAME && !process.env.VDG_WORK) { console.error('SKIP_MAME=1 reuses captures in VDG_WORK: set VDG_WORK too'); process.exitCode = 2; return; }
const { runMame } = require('../lib/mame');
const { compositeCheck } = require('../lib/composite');
const ARTIFACT = process.env.ARTIFACT === undefined ? 1 : +process.env.ARTIFACT;

const asm = Emu.assemble(fs.readFileSync(path.join(__dirname, 'vdg.asm'), 'utf8'), '6803');
if (!asm.ok) { console.error(asm.errors); process.exitCode = 1; return; }   // module top level: nothing below runs
const rom = new Uint8Array(0x2000).fill(0x01);
for (const s of asm.segments) rom.set(s.data, s.addr - 0xE000);
fs.mkdirSync(path.join(WORK, 'roms/mc10'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'roms/mc10/mc10.rom'), rom);

// MAME is recorded with -aviwrite (one bitmap per emulated frame) and each mode is captured from the frame
// 15 frames after the firmware's phase changes, in both emulators: a steady frame showing that mode only.
const { readAvi, toRGBA } = require('../lib/avi');
const caps = {};
{
  const avi = path.join(WORK, 'vdg.avi'), log = path.join(WORK, 'phases.txt');
  for (const f of [avi, log]) try { fs.unlinkSync(f); } catch (e) { /* none */ }
  runMame({ work: WORK, system: 'mc10', seconds: 15, args: ['-ramsize', '20K', '-aviwrite', avi],
    lua: `manager.machine.ioport.ports[":mc6847:artifacting"].fields["Artifacting"].user_value = ${ARTIFACT}
local space = manager.machine.devices[":maincpu"].spaces["program"]
local f = io.open("${log}", "wb")
emu.register_frame_done(function() f:write(string.format("%d\\n", space:read_u8(0x8F00))) f:flush() end)
` });
  const movie = readAvi(avi), phases = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number);
  let last = -1, wait = -1;
  for (let i = 0; i < Math.min(movie.frames.length, phases.length); i++) {
    const ph = phases[i];
    if (ph !== last) { last = ph; wait = 15; }
    if (wait > 0) wait--;
    else if (wait === 0) { wait = -1; caps[ph] = { w: movie.w, h: movie.h, px: toRGBA(movie, movie.frames[i]) }; }
  }
  if (!process.env.KEEP) fs.unlinkSync(avi);
}

// ---- our captures (same rule: 15 frames after the phase changes) ----
const m = Emu.createMachine('mc10', { mameCompat: true });
m.setRoms({ basic: rom }); m.reset(true);
m.vdg.artifact = ARTIFACT;
const ours = {}, codes = {};
let last = -1, wait = -1;
for (let f = 0; f < 800; f++) {
  m.runFrame();
  const ph = m.ram[0x8F00];
  if (ph !== last) { last = ph; wait = 15; }
  if (wait > 0) wait--;
  else if (wait === 0) { wait = -1; ours[ph] = Emu.frameToRGBA(m.render()); codes[ph] = m.render().data.slice(); }
}

const NAMES = ['', 'text CSS0', 'text CSS1', 'SG6 CSS0', 'SG6 CSS1', 'CG1 CSS0', 'CG1 CSS1', 'RG1 CSS0', 'RG1 CSS1',
  'CG2 CSS0', 'CG2 CSS1', 'RG2 CSS0', 'RG2 CSS1', 'CG3 CSS0', 'CG3 CSS1', 'RG3 CSS0', 'RG3 CSS1', 'CG6 CSS0', 'CG6 CSS1', 'RG6 CSS0', 'RG6 CSS1'];
// locate MAME's active area: in text mode the border is black and the active area is not
const first = caps[1];
if (!first) { console.log('no MAME captures'); process.exitCode = 1; return; }
const border = first.px[0];
let x0 = first.w, y0 = first.h;
for (let y = 0; y < first.h; y++) for (let x = 0; x < first.w; x++) if (first.px[y * first.w + x] !== border) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
console.log(`MAME bitmap ${first.w}x${first.h}, active area at ${x0},${y0}`);

let total = 0, failed = 0;
const M = (cap, x, y) => cap.px[(y0 + y) * cap.w + x0 + x] & 0xFFFFFF;
const O = (ph, x, y) => ours[ph][(24 + y) * VDGC.WIDTH + 32 + x] & 0xFFFFFF;
for (let ph = 1; ph <= 20; ph++) {
  const cap = caps[ph];
  total++;
  if (!cap || !ours[ph]) { console.log(`phase ${ph}: missing capture`); failed++; continue; }
  // colour map MAME -> ours by majority vote, one to one
  const votes = new Map();
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const k = M(cap, x, y) * 0x1000000 + O(ph, x, y);
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  const map = new Map(), used = new Set();
  for (const k of [...votes.keys()].sort((a, b) => votes.get(b) - votes.get(a))) {
    const mc = Math.floor(k / 0x1000000), oc = k % 0x1000000;
    if (!map.has(mc) && !used.has(oc)) { map.set(mc, oc); used.add(oc); }
  }
  let bad = 0;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) if (map.get(M(cap, x, y)) !== O(ph, x, y)) bad++;
  const { mixes, wrong, first: firstMix } = compositeCheck(Emu, ARTIFACT, (x, y) => codes[ph][(24 + y) * VDGC.WIDTH + 32 + x],
    // (the AVI's pixels are little-endian RGBA, as ours; compositeCheck takes 0xRRGGBB)
    (x, y) => { const v = M(cap, x, y); return ((v & 0xFF) << 16) | (v & 0xFF00) | (v >> 16); });
  if (bad || wrong) failed++;
  console.log(`${bad || wrong ? 'DIFF' : 'SAME'}  ${NAMES[ph].padEnd(10)} ${bad} of 49152 pixels differ, ${used.size} colours` +
    (mixes ? `; composite colour: ${mixes - wrong} of ${mixes} pixels are MAME's own mix colour${firstMix ? `, first difference ${firstMix}` : ''}` : ''));
}
console.log(`${total - failed}/${total} modes identical (artifacting ${ARTIFACT})`);
process.exitCode = failed ? 1 : 0;
