// Compare rendered video against MAME: node tools/mame-diff/run.js <profile> --video [--artifact N]
// Runs vdg.asm (our own firmware) on both emulators, captures every display mode and
// compares the 256x192 active area pixel by pixel (palettes are matched automatically, one to one).
// Composite colour is compared exactly too: NTSC artifact colours in the 256x192 mode and PAL line-pair
// blending (mc6847.cpp, artifacter). ARTIFACT=N sets MAME's "Artifacting" option (0 off, 1 Standard,
// 2 Reverse; MAME's default is 1) and ours to the same value.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '../../..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();
const PROFILE_ID = process.argv[2] || 'dragon64';
// --ram N: compare a machine with that much RAM (MAME -ramsize, ours config.ram). The video firmware keeps
// its display data at $0000-$17FF and its phase counter at $7000, so a 16K machine needs a lower counter
// (small RAM cannot hold $7000); only the sizes whose pictures the firmware can describe are offered.
const RAM_ARG = (() => { const i = process.argv.indexOf('--ram'); return i > 0 ? Number(process.argv[i + 1]) : null; })();
const PROFILE = Emu.profiles[PROFILE_ID];
const { png } = require('../lib/png');
const { workDir, keepWorkDir } = require('../lib/workdir');
// VDG_WORK: a folder of your own, kept (and needed by SKIP_MAME=1); otherwise a fresh one, removed at exit
const WORK = process.env.VDG_WORK || workDir(`${PROFILE_ID}${RAM_ARG ? `-${RAM_ARG}k` : ''}-vdg`);
if (process.env.SKIP_MAME && !process.env.VDG_WORK) { console.error('SKIP_MAME=1 reuses captures in VDG_WORK: set VDG_WORK too'); process.exitCode = 2; return; }
const { runMame } = require('../lib/mame');
const { genChargen } = require('./spec');
const { compositeCheck } = require('../lib/composite');

// The phase counter lives at $7000, which only a machine of 32K or more has; below that the firmware is
// assembled with it lowered into the fitted RAM (PHASE is an absolute address in vdg.asm). The display data
// at $0000-$17FF fits everywhere, so the pictures themselves are the same.
const PHASE_ADDR = RAM_ARG && RAM_ARG < 32 ? 0x0800 : 0x7000;
const RAM_TOP = RAM_ARG && RAM_ARG < 32 ? RAM_ARG * 1024 : 0x7F00;
let vdgSrc = fs.readFileSync(path.join(__dirname, 'vdg.asm'), 'utf8');
if (PHASE_ADDR !== 0x7000) vdgSrc = vdgSrc.replace(/^PHASE\s+EQU\s+\$7000/m, `PHASE   EQU     $${PHASE_ADDR.toString(16).toUpperCase()}`);
// the stack is at $7F00 too, which a small machine does not have: put it at the top of the fitted RAM
if (RAM_TOP !== 0x7F00) vdgSrc = vdgSrc.replace(/LDS\s+#\$7F00/, `LDS     #$${RAM_TOP.toString(16).toUpperCase()}`);
const asm = Emu.assemble(vdgSrc);
if (!asm.ok) { console.error(asm.errors); process.exitCode = 1; return; }   // module top level: nothing below runs
const rom = new Uint8Array(0x4000).fill(0x12);
for (const s of asm.segments) rom.set(s.data, s.addr - 0x8000);
const romDir = path.join(WORK, 'roms', PROFILE.mame);
fs.mkdirSync(romDir, { recursive: true });
fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });
const slotData = {};
for (const sl of PROFILE.roms) {
  // the 200-E's character generator: a chip our tools build, installed in MAME's chargen slot and fitted in
  // our machine. It is not firmware, so it is not sliced out of the assembled image (which has no such
  // address). The comparison therefore proves the VDG's addressing and the wiring, not the real glyphs.
  slotData[sl.id] = sl.chip ? genChargen() : rom.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  for (const f of sl.files) fs.writeFileSync(path.join(romDir, f), slotData[sl.id]);
}
// install() in spec.js writes the 200-E's LK1 link; the video run goes through this script instead
if (PROFILE.charGen) {
  const cfgDir = path.join(WORK, 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, `${PROFILE.mame}.cfg`),
    `<?xml version="1.0"?>\n<mameconfig version="10">\n\t<system name="${PROFILE.mame}">\n\t\t<input>\n` +
    `\t\t\t<port tag="LK1" type="CONFIG" mask="1" defvalue="1" value="1" />\n\t\t</input>\n\t</system>\n</mameconfig>\n`);
}

const ARTIFACT = process.env.ARTIFACT === undefined ? 1 : +process.env.ARTIFACT;
// the Dragon Alpha boots through its boot ROM socket (alpha/spec.js): the image goes in its BASIC socket
if (PROFILE.family === 'alpha') {
  Object.assign(slotData, require('../alpha/spec').slotsFor(rom));
  for (const sl of PROFILE.roms) for (const f of sl.files) fs.writeFileSync(path.join(romDir, f), slotData[sl.id]);
}
if (!process.env.SKIP_MAME) {
  const lua = path.join(WORK, 'dump.lua');
  fs.writeFileSync(lua, `manager.machine.ioport.ports[":vdg:artifacting"].fields["Artifacting"].user_value = ${ARTIFACT}
local space = manager.machine.devices[":maincpu"].spaces["program"]
local scr = nil
for tag, s in pairs(manager.machine.screens) do scr = s end
local last, wait = -1, -1
emu.register_frame_done(function()
  local ph = space:read_u8(${PHASE_ADDR})
  if ph ~= last then last = ph; wait = 15 end
  if wait > 0 then wait = wait - 1
  elseif wait == 0 then
    wait = -1
    local px, w, h = scr:pixels()
    local f = io.open(string.format("${WORK}/out/phase%02d.raw", ph), "wb")
    f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
  end
end)
`);
  runMame({ work: WORK, system: PROFILE.mame, lua: fs.readFileSync(lua, 'utf8'), seconds: 14, args: ['-ext', '', '-frameskip', '0', '-noautoframeskip', ...(RAM_ARG ? ['-ramsize', `${RAM_ARG}K`] : [])] });
}

// ---- our captures (same rule: 3 frames after the phase changes) ----
const m = Emu.createMachine(PROFILE_ID, RAM_ARG ? { ram: RAM_ARG } : {});
m.setRoms(slotData); m.reset(true);
m.vdg.artifact = ARTIFACT;
const ours = {}, codes = {};
let last = -1, wait = -1;
for (let f = 0; f < 700; f++) {
  m.runFrame();
  const ph = m.ram[PHASE_ADDR];
  if (ph !== last) { last = ph; wait = 15; }
  if (wait > 0) wait--;
  else if (wait === 0) { wait = -1; ours[ph] = Emu.frameToRGBA(m.render()); codes[ph] = m.render().data.slice(); }
}

const NAMES = ['', 'text CSS0', 'text CSS1', 'SG6 CSS0', 'SG6 CSS1', 'CG1 CSS0', 'CG1 CSS1', 'RG1 CSS0', 'RG1 CSS1',
  'CG2 CSS0', 'CG2 CSS1', 'RG2 CSS0', 'RG2 CSS1', 'CG3 CSS0', 'CG3 CSS1', 'RG3 CSS0', 'RG3 CSS1', 'CG6 CSS0', 'CG6 CSS1', 'RG6 CSS0', 'RG6 CSS1'];

// minimal PNG writer for diff images
let total = 0, failed = 0;
for (let ph = 1; ph <= 20; ph++) {
  // Under -video none MAME only refreshes its screen bitmap on partial updates (mode changes),
  // so the bitmap captured during phase N+1 is the last full frame of phase N.
  const file = path.join(WORK, 'out', `phase${String(ph + 1).padStart(2, '0')}.raw`);
  if (!fs.existsSync(file) || !ours[ph]) { console.log(`phase ${ph}: missing capture`); failed++; continue; }
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(10);
  const [mw, mh] = buf.slice(0, nl).toString().split(" ").map(Number);
  const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
  const op = ours[ph];
  // active areas
  const yoff = mh >= 290 ? 50 : 25; // PAL captures include 25 padding lines above the top border
  const M = (x, y) => mp[(yoff + y) * mw + 58 + x] & 0xFFFFFF;
  const O = (x, y) => op[(24 + y) * Emu.MC6847.WIDTH + 32 + x] & 0xFFFFFF;
  // learn palette mapping MAME colour -> our colour by majority vote
  const votes = new Map();
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const k = M(x, y) + ':' + O(x, y);
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  const map = new Map();
  for (const [k, n] of [...votes.entries()].sort((a, b) => b[1] - a[1])) {
    const [mc, oc] = k.split(':').map(Number);
    if (!map.has(mc) && ![...map.values()].includes(oc)) map.set(mc, oc);
  }
  const { mixes, wrong: wrongMix, first: firstMix } = compositeCheck(Emu, ARTIFACT, (x, y) => codes[ph][(24 + y) * Emu.MC6847.WIDTH + 32 + x], M);
  let bad = wrongMix;
  const img = Buffer.alloc(256 * 3 * 192 * 4);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const ok = map.get(M(x, y)) === O(x, y);
    if (!ok) bad++;
    const put = (xx, c) => { const i = (y * 768 + xx) * 4; img[i] = c & 0xFF; img[i + 1] = (c >> 8) & 0xFF; img[i + 2] = (c >> 16) & 0xFF; img[i + 3] = 255; };
    const mc = M(x, y); put(x, ((mc >> 16) & 0xFF) | (mc & 0xFF00) | ((mc & 0xFF) << 16));
    put(256 + x, O(x, y));
    put(512 + x, ok ? 0x202020 : 0x0000FF);
  }
  total++;
  if (bad) {
    failed++;
    fs.writeFileSync(path.join(WORK, `diff-phase${String(ph).padStart(2, '0')}.png`), png(768, 192, img));
    keepWorkDir(WORK, 'difference images');
  }
  console.log(`${bad ? 'DIFF' : 'SAME'}  ${NAMES[ph].padEnd(10)} ${bad - wrongMix} of 49152 pixels differ, ${new Set(map.values()).size} colours` +
    (mixes ? `; composite colour: ${mixes - wrongMix} of ${mixes} pixels are MAME's own mix colour${firstMix ? `, first difference ${firstMix}` : ''}` : ''));
}
console.log(`${total - failed}/${total} modes identical (artifacting ${ARTIFACT})`);
process.exitCode = failed ? 1 : 0;
