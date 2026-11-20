// The Dragon 64 Plus's 80-column text screens against MAME, pixel by pixel, one comparison per screen.
//
//   node tools/mame-diff/run.js d64plus --plustext --video [--keep]
//
// The firmware is plustext.asm (text-screens.js): each screen clears the 2K video RAM, writes its text, sets R1, R6,
// R9 and R12/R13, and holds for FIELDS field syncs with its number in PHASE. Both pictures are taken once a screen
// has been up four frames (a register written mid-frame shows from the next frame).
//
// The video RAM. MAME 0.264 never applies the $FFE2 bank register to memory (docs/verification.md, "Deviations from
// MAME"), so in MAME the firmware's writes land in the standard RAM and the board's :video_ram share is never
// written. The Lua script therefore puts each screen's 2K (text-screens.js videoRam(), built from the screen's own
// writes) into that share when the screen's phase begins, before any frame of it is captured. Our machine runs the
// firmware without mameCompat, so its own writes fill the video RAM through bank C: a pixel match also shows our
// firmware's writes put exactly those bytes there.
//
// The character generator is TEXTGEN below in both, our own pattern (never a real font): on the even raster lines of
// a cell the byte is the cell's whole 8-bit code, on the odd ones a value from the raster line alone. So every cell's
// code is in the picture in full, and a match proves which code each cell holds and from which address, row and
// column - the start address, R1's row pitch, the 2K wrap and the 14-bit start. (spec.js genChargen(), which the
// other d64plus comparisons use, keeps only the code's low four bits, so codes sharing them would draw alike; a
// drawing that turned code c into c ^ $40 passed with it and fails with this one.) The real font is user-supplied.
// MAME sizes its screen to the displayed area (mc6845.cpp recompute_parameters: R1 x 8 by R6 x (R9 + 1)); ours is
// always 640 x 264, so the comparison covers MAME's area and requires ours to be dark outside it.
const fs = require('fs'), path = require('path');
const { runMame } = require('../lib/mame');
const spec = require('./spec');
const T = require('./text-screens');

// address (code << 4) | ra -> the byte: the code on even rasters, ~ra * $11 on odd ones (MAME masks the address to
// 4K, crtc_update_row's & 0xfff, so the second 4K is never read; it repeats the first)
const TEXTGEN = new Uint8Array(0x2000);
for (let a = 0; a < TEXTGEN.length; a++) { const ra = a & 0x0F; TEXTGEN[a] = ra & 1 ? (~ra * 0x11) & 0xFF : (a >> 4) & 0xFF; }

function compare(profileId, { keep = false } = {}) {
  const t = spec.plusText(profileId, { work: `/tmp/mame-diff/${profileId}-plustext-video`, chargen: TEXTGEN });
  t.install();
  const N = T.SCREENS.length, out = (i) => path.join(t.work, `screen${i}.raw`);
  for (let i = 0; i < N; i++) { try { fs.unlinkSync(out(i)); } catch (e) { /* none */ } }
  const vram = T.SCREENS.map((s) => `{${Array.from(T.videoRam(s)).join(',')}}`).join(',\n');
  runMame({
    work: t.work, system: t.system, seconds: 30, args: t.args,
    lua: `local scr = manager.machine.screens[":plus_screen"]
local share = manager.machine.memory.shares[":video_ram"]
local space = manager.machine.devices[":maincpu"].spaces["program"]
local vram = {
${vram}
}
local last, settled = -1, 0
emu.register_frame_done(function()
  local ph = space:read_u8(${T.PHASE})
  if ph ~= last then
    last = ph; settled = 0
    if ph >= 1 and ph <= ${N} then
      local v = vram[ph]
      for i = 1, #v do share:write_u8(i - 1, v[i]) end
    end
  end
  if ph > ${N} then manager.machine:exit() return end
  if ph >= 1 then
    settled = settled + 1
    if settled == 5 then
      local px, w, h = scr:pixels()
      local f = io.open("${t.work}/screen" .. (ph - 1) .. ".raw", "wb"); f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
    end
  end
end)
`,
  });

  // ours: the same firmware without mameCompat, each screen taken after the same settling
  const ours = spec.plusText(profileId, { regenerate: false, config: { mameCompat: false }, work: t.work, chargen: TEXTGEN }).machine();
  ours.view = 'plus';
  const pictures = [];
  T.runOurs(ours, { settle: 4, onScreen: (i, mm) => { if (i < N) { const f = mm.render(); pictures[i] = { w: f.width, h: f.height, data: f.data.slice() }; } } });

  let failed = 0;
  T.SCREENS.forEach((s, i) => {
    if (!fs.existsSync(out(i))) { console.log(`[${profileId}] ${s.name}: MAME captured no picture`); failed++; return; }
    if (!pictures[i]) { console.log(`[${profileId}] ${s.name}: our machine never showed the screen`); failed++; return; }
    const buf = fs.readFileSync(out(i)), nl = buf.indexOf(10);
    const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
    const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
    const o = pictures[i];
    let diff = 0, first = null, lit = 0, outside = 0;
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
      const lo = o.data[y * o.w + x] !== 0;
      if (x >= mw || y >= mh) { if (lo) outside++; continue; }
      const lm = ((mp[y * mw + x] >> 8) & 0xFF) > 0x7F;
      if (lm) lit++;
      if (lm !== lo) { diff++; if (!first) first = [x, y]; }
    }
    const want = [s.r1 * 8, s.r6 * (s.r9 + 1)];
    const sizeOk = mw === want[0] && mh === want[1];
    console.log(`[${profileId}] ${s.name}: MAME ${mw}x${mh}${sizeOk ? '' : ` (expected ${want[0]}x${want[1]})`}, ` +
      `${diff} of ${mw * mh} pixels differ${first ? `, first at (${first[0]},${first[1]})` : ''}; ${lit} lit; ours lit outside MAME's area: ${outside}`);
    if (diff || outside || !sizeOk) failed++;
  });
  console.log(failed ? `${failed} of ${N} screens differ` : `all ${N} screens identical`);
  if (!keep && !failed) fs.rmSync(t.work, { recursive: true, force: true });
  return failed ? 1 : 0;
}

module.exports = { compare };
if (require.main === module) process.exitCode = compare(process.argv[2] || 'd64plus', { keep: process.argv.includes('--keep') });
