// Compare the welcome program's drawn screen against MAME on the MC-10 and the Alice: the shipped program
// (HALTCODE=1 comparison build, run through the ROM-slot loader mc10/gen-welcome.js generates) after it
// HALTs, frame by frame the whole 256x192 active area pixel by pixel, with MAME's palette matched to ours
// one to one. Artifacting is set the same on both (1 = MAME's default "Standard").
//
//   node tools/mame-diff/mc10/run-welcome-video.js mc10 [--keep]
//   node tools/mame-diff/mc10/run-welcome-video.js alice [--keep]
//   ... [--back]: the returning visitor's menu (WELCOME BACK and option 5; gen-welcome.js --back)
//
// This is the video half of node tools/mame-diff/run.js <profile> --welcome (which does the lockstep).
const fs = require('fs'), path = require('path');
const Emu = require('../../../tests/load.js')();
const VDGC = Emu.MC6847;
const { workDir } = require('../lib/workdir');
const { runMame } = require('../lib/mame');
const { readAvi, toRGBA } = require('../lib/avi');

// a plain function ending in `return`, so nothing forces process.exit() (Node 25 deadlocks in it)
function main() {
  const profileId = process.argv[2] || 'mc10';
  const KEEP = process.argv.includes('--keep');
  const profile = Emu.profiles[profileId];
  if (!profile) { console.error('usage: run-welcome-video.js <mc10|alice>'); process.exitCode = 2; return; }
  const ARTIFACT = 1;
  const BACK = process.argv.includes('--back');
  const WORK = workDir(`${profileId}-welcome-video${BACK ? '-back' : ''}`);

  // ---- build the comparison image the same way spec.welcome() does ----
  const spec = require('./spec.js');
  const t = spec.welcome(profileId, { regenerate: true, back: BACK, work: WORK });

  // ---- MAME: run it, record every frame, and log the frame at which the program HALTs ----
  const avi = path.join(WORK, 'welcome.avi'), haltLog = path.join(WORK, 'halt.txt');
  for (const f of [avi, haltLog]) try { fs.unlinkSync(f); } catch (e) { /* none */ }
  t.install();
  runMame({ work: WORK, system: profile.mame, seconds: 8, video: true, args: ['-ramsize', '20K', '-aviwrite', avi],
    lua: `manager.machine.ioport.ports[":mc6847:artifacting"].fields["Artifacting"].user_value = ${ARTIFACT}
local cpu = manager.machine.devices[":maincpu"]
local f = io.open("${haltLog}", "wb")
local n, done = 0, -1
emu.register_frame_done(function()
  if done < 0 and cpu.state["PC"].value == ${t.haltPc} then done = n end
  f:write(string.format("%d\\n", done)) f:flush() n = n + 1
end)
` });
  const movie = readAvi(avi);
  const halts = fs.readFileSync(haltLog, 'utf8').trim().split('\n').map(Number);
  // the HALT is a BRA-to-self; take a steady frame a few after it is first seen
  const haltFrame = halts.findIndex((v) => v >= 0);
  if (haltFrame < 0 || !movie.frames[haltFrame + 5]) { console.log(`MAME: the program did not HALT (${halts.length} frames recorded)`); process.exitCode = 1; return; }
  const mcap = { w: movie.w, h: movie.h, px: toRGBA(movie, movie.frames[haltFrame + 5]) };

  // ---- ours: the same image, the same point ----
  const m = t.machine();
  m.vdg.artifact = ARTIFACT;
  let ourFrame = -1;
  for (let f = 0; f < (haltFrame + 5) * 2 && ourFrame < 0; f++) { m.runFrame(); if (m.cpu.pc === t.haltPc) ourFrame = f; }
  if (ourFrame < 0) { console.log('ours: the program did not HALT'); process.exitCode = 1; return; }
  for (let f = 0; f < 5; f++) m.runFrame();
  const opx = Emu.frameToRGBA(m.render());

  // ---- compare the active area, palette matched one to one by majority vote ----
  const border = mcap.px[0];
  let x0 = mcap.w, y0 = mcap.h;
  for (let y = 0; y < mcap.h; y++) for (let x = 0; x < mcap.w; x++) if (mcap.px[y * mcap.w + x] !== border) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
  console.log(`MAME bitmap ${mcap.w}x${mcap.h}, active area at ${x0},${y0}; halted at frame ${haltFrame}, compared frame ${haltFrame + 5}`);
  const M = (x, y) => mcap.px[(y0 + y) * mcap.w + x0 + x] & 0xFFFFFF;
  const O = (x, y) => opx[(24 + y) * VDGC.WIDTH + 32 + x] & 0xFFFFFF;
  const votes = new Map();
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const k = M(x, y) * 0x1000000 + O(x, y);
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  const map = new Map(), used = new Set();
  for (const k of [...votes.keys()].sort((a, b) => votes.get(b) - votes.get(a))) {
    const mc = Math.floor(k / 0x1000000), oc = k % 0x1000000;
    if (!map.has(mc) && !used.has(oc)) { map.set(mc, oc); used.add(oc); }
  }
  let bad = 0;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) if (map.get(M(x, y)) !== O(x, y)) bad++;
  console.log(`${bad === 0 ? 'SAME' : 'DIFF'}  ${bad} of 49152 pixels differ, ${used.size} colours`);
  if (bad) {
    let shown = 0;
    for (let y = 0; y < 192 && shown < 12; y++) for (let x = 0; x < 256 && shown < 12; x++) {
      if (map.get(M(x, y)) !== O(x, y)) { console.log(`  (${x},${y}) MAME ${M(x, y).toString(16)}, ours ${O(x, y).toString(16)}`); shown++; }
    }
  }
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  process.exitCode = bad ? 1 : 0;
}

main();
