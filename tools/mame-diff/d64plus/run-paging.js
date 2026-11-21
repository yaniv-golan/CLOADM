// The Dragon 64 Plus's 32-column (MC6847) picture under every $FFE2 paging, against MAME, pixel by pixel.
//
//   node tools/mame-diff/run.js d64plus --paging --video [--keep]
//
// The firmware is paging.asm: text mode from $0000 holding a pattern in the motherboard RAM, then one phase per
// $FFE2 value ($00, $02, $06, $01, $03, $07, $04, $05), each held for 30 fields with its number at PHASE. The
// Harvey-Smith traced Dragon 64 Plus schematic (owner-supplied research; known drawing errors) has the MC6847 fetch
// from the motherboard RAM whatever the paging, and MAME 0.264 never applies $FFE2 to memory, so both pictures must
// be the motherboard's pattern in every phase. Ours runs WITHOUT mameCompat, so its banks do reach the CPU: a VDG
// that saw bank A, bank B or the video RAM (all zero on ours, never written) would draw a different screen.
//
// Headless MAME redraws its bitmap only on a partial update (a mode change), so each phase changes CSS and the
// bitmap taken during phase N + 1 is the last full frame of phase N (as in sam/run-vdg.js). The palettes are matched
// one to one by majority vote over the 256 x 192 active area.
const fs = require('fs'), path = require('path');
const { runMame } = require('../lib/mame');
const spec = require('./spec');

const PHASE = 0x3F00;
const NAMES = ['', '$00 standard', '$02 bank A', '$06 bank B', '$01 video RAM', '$03 bank A + video RAM', '$07 bank B + video RAM', '$04 (R2 R1 = 10)', '$05 (R2 R1 = 10) + video RAM'];
const N = NAMES.length - 1;

function compare(profileId, { keep = false } = {}) {
  const t = spec.paging(profileId, { work: `/tmp/mame-diff/${profileId}-paging-video` });
  t.install();
  const out = (ph) => path.join(t.work, `phase${ph}.raw`);
  for (let ph = 1; ph <= N + 1; ph++) { try { fs.unlinkSync(out(ph)); } catch (e) { /* none */ } }
  runMame({
    work: t.work, system: t.system, seconds: 12, args: [...t.args, '-frameskip', '0', '-noautoframeskip'],
    lua: `local space = manager.machine.devices[":maincpu"].spaces["program"]
local scr = manager.machine.screens[":screen"]
local last, wait = -1, -1
emu.register_frame_done(function()
  local ph = space:read_u8(${PHASE})
  if ph ~= last then last = ph; wait = 15 end
  if wait > 0 then wait = wait - 1
  elseif wait == 0 then
    wait = -1
    local px, w, h = scr:pixels()
    local f = io.open("${t.work}/phase" .. ph .. ".raw", "wb"); f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
    if ph > ${N} then manager.machine:exit() end
  end
end)
`,
  });

  // ours: the same firmware and the same rule (15 frames after the phase changes)
  const Emu = require('../lib/firmware').loadEmu();
  const m = t.machine();
  const ours = {};
  let last = -1, wait = -1;
  for (let f = 0; f < 600 && !(ours[N]); f++) {
    m.runFrame();
    const ph = m.ram[PHASE];
    if (ph !== last) { last = ph; wait = 15; }
    if (wait > 0) wait--;
    else if (wait === 0) { wait = -1; ours[ph] = Emu.frameToRGBA(m.render()); }
  }

  let failed = 0;
  for (let ph = 1; ph <= N; ph++) {
    const file = out(ph + 1);
    if (!fs.existsSync(file) || !ours[ph]) { console.log(`[${profileId}] ${NAMES[ph]}: missing capture`); failed++; continue; }
    const buf = fs.readFileSync(file), nl = buf.indexOf(10);
    const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
    const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
    const op = ours[ph];
    const yoff = mh >= 290 ? 50 : 25;     // PAL captures include 25 padding lines above the top border
    const M = (x, y) => mp[(yoff + y) * mw + 58 + x] & 0xFFFFFF;
    const O = (x, y) => op[(24 + y) * Emu.MC6847.WIDTH + 32 + x] & 0xFFFFFF;
    const votes = new Map();
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const k = M(x, y) + ':' + O(x, y); votes.set(k, (votes.get(k) || 0) + 1); }
    const map = new Map();
    for (const [k] of [...votes.entries()].sort((a, b) => b[1] - a[1])) {
      const [mc, oc] = k.split(':').map(Number);
      if (!map.has(mc) && ![...map.values()].includes(oc)) map.set(mc, oc);
    }
    let bad = 0;
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) if (map.get(M(x, y)) !== O(x, y)) bad++;
    console.log(`[${profileId}] ${bad ? 'DIFF' : 'SAME'}  ${NAMES[ph].padEnd(30)} ${bad} of 49152 pixels differ, ${map.size} colours`);
    if (bad) failed++;
  }
  console.log(failed ? `${failed} of ${N} pagings differ` : `all ${N} pagings identical`);
  if (!keep && !failed) fs.rmSync(t.work, { recursive: true, force: true });
  return failed ? 1 : 0;
}

module.exports = { compare };
if (require.main === module) process.exitCode = compare(process.argv[2] || 'd64plus', { keep: process.argv.includes('--keep') });
