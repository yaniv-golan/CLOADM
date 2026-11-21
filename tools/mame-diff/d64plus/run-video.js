// The Dragon 64 Plus's 80-column screen against MAME, pixel by pixel.
//
//   node tools/mame-diff/run.js d64plus --plus-video [--keep]
//
// Our firmware (plus.asm) programs the CRTC, fills the video RAM bank with character codes and moves the
// cursor and start address; the screen it leaves is drawn on the CRTC's second and later frames. MAME's
// plus_screen is captured through Lua (screen:pixels()); ours comes from D64PlusMachine.render() with
// view 'plus'. Both are 640x264 with only two pens (MAME's palette is palette_device::MONOCHROME: black
// and white), so a pixel either matches or it does not - there is no colour map to learn and no tolerance.
//
// The character generator is the pattern tools/mame-diff/d64plus/spec.js builds, installed in MAME's
// chargen slot and loaded into our machine, so both emulators fetch the same glyph bytes: the comparison
// proves the addressing (code << 4 | ra), the 8x12 cell geometry, the cursor column forced to $FF and the
// start-address/row walk - not the real font, which needs a user-supplied ROM.
const fs = require('fs'), path = require('path');
const { loadEmu } = require('../lib/firmware');
const { png } = require('../lib/png');
const { runMame } = require('../lib/mame');
const spec = require('./spec');

const hx = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');

// compare(profileId) -> 0 if every pixel matched
function compare(profileId, { keep = false } = {}) {
  const Emu = loadEmu();
  const t = spec.plus(profileId, { work: `/tmp/mame-diff/${profileId}-plus-video` });
  t.install();
  // our machine with the same images the spec wrote (it rebuilt them when it ran)
  const ourMachine = t.machine();
  ourMachine.view = 'plus';

  // MAME: run to a settled frame and capture the plus screen
  const OUT = path.join(t.work, 'plus.raw');
  try { fs.unlinkSync(OUT); } catch (e) { /* none */ }
  runMame({
    work: t.work, system: t.system, seconds: 6, args: t.args,
    lua: `local scr = manager.machine.screens[":plus_screen"]
local settled = 0
emu.register_frame_done(function()
  -- the firmware has halted (its HALT loop stores $01 at $0000 on the way). Its last writes moved the
  -- CRTC's start address and the cursor; a register written mid-frame shows from the next frame, so wait
  -- a few frames before taking the picture (the VDG harness waits 15 for the same reason).
  local space = manager.machine.devices[":maincpu"].spaces["program"]
  if space:read_u8(0x0000) == 0x01 then
    settled = settled + 1
    if settled == 4 then
      local px, w, h = scr:pixels()
      local f = io.open("${OUT}", "wb"); f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
      manager.machine:exit()
    end
  end
end)
`,
  });
  const buf = fs.readFileSync(OUT);
  const nl = buf.indexOf(10);
  const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
  const mp = new Uint32Array(buf.buffer, buf.byteOffset + nl + 1, (buf.length - nl - 1) / 4);

  // ours: run past the halt too, then take the plus picture
  for (let i = 0; i < 40; i++) ourMachine.runFrame();
  const f = ourMachine.render(), W = f.width, H = f.height;
  const op = Emu.frameToRGBA(f);

  // MAME's pen values (palette_device::MONOCHROME): two entries; ours are the two grey codes. Both pictures
  // are black-and-white, so a pixel matches when both are dark or both are lit - no colour mapping needed.
  const litM = (c) => ((c >> 8) & 0xFF) > 0x7F;
  const litO = (c) => ((c >> 8) & 0xFF) > 0x7F;
  const rows = Math.min(H, mh), cols = Math.min(W, mw);
  let diff = 0, first = null, mameLit = 0, ourLit = 0;
  const img = Buffer.alloc(cols * 3 * rows * 4);
  const put = (x, y, v) => { const i = (y * cols * 3 + x) * 4; img[i] = img[i + 1] = img[i + 2] = v; img[i + 3] = 255; };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const mv = mp[y * mw + x], ov = op[y * W + x];
    const lm = litM(mv), lo = litO(ov);
    if (lm) mameLit++;
    if (lo) ourLit++;
    const same = lm === lo;
    if (!same) { diff++; if (!first) first = [x, y]; }
    put(x, y, lm ? 0xFF : 0x00);
    put(cols + x, y, lo ? 0xFF : 0x00);
    put(2 * cols + x, y, same ? 0x20 : 0x00FF00);
  }
  console.log(`[${profileId}] plus screen ${W}x${H} against MAME's ${mw}x${mh}: ` +
    `${diff} of ${cols * rows} pixels differ` + (first ? `, first at (${first[0]},${first[1]})` : ''));
  console.log(`  lit pixels: MAME ${mameLit}, ours ${ourLit} (${(100 * mameLit / (cols * rows)).toFixed(1)}% and ${(100 * ourLit / (cols * rows)).toFixed(1)}%)`);
  if (diff) {
    fs.writeFileSync(path.join(t.work, 'plus-diff.png'), png(cols * 3, rows, img));
    console.log(`  wrote ${path.join(t.work, 'plus-diff.png')}`);
  }
  if (!keep && !diff) fs.rmSync(t.work, { recursive: true, force: true });
  return diff ? 1 : 0;
}

module.exports = { compare };
if (require.main === module) process.exitCode = compare(process.argv[2] || 'd64plus', { keep: process.argv.includes('--keep') });
