#!/usr/bin/env node
// The floppy boot's reference for tests/nitros9.test.js: a NitrOS-9 floppy image (the release's _40d_1.dsk) booted
// in MAME 0.264 (coco3h for the 6309, coco3 for the 6809) with our floppy loader (js/machines/nitros9.js) as the
// internal ROM and the CoCo disk controller (-ext fdc, 525dd drives) holding the image in drive 0. The controller's
// own ROM socket gets 8K of $39 (RTS), never run: the loader keeps the 32K internal ROM mapped. Return is typed at the
// startup's time prompt and then `dir` (lib.js FLOPPY), and every CPU write to $FF40-$FF4F is recorded by a Lua
// write tap.
//   node tools/nitros9/boot-floppy-mame.js <image.dsk> [--cpu 6309|6809] [--png out.png] [--record FILE]
// --record writes the writes (lib.js fdcWrites' form) as JSON: tests/fixtures/nitros9/ holds them.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const { loadEmu, writeProfileRoms, writeRoms, mameVersion } = require('../mame-diff/lib/firmware');
const { MAME, baseArgs, env } = require('../mame-diff/lib/mame');
const { loaderRom, FLOPPY } = require('./lib');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const image = argv.find((a) => a.endsWith('.dsk'));
const cpu = opt('--cpu', '6809'), pngOut = opt('--png', null), recordFile = opt('--record', null);
const seconds = FLOPPY.seconds;

const Emu = loadEmu();
const system = cpu === '6309' ? 'coco3h' : 'coco3';
const work = `/tmp/mame-diff/nitros9-floppy-${system}`;
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
writeProfileRoms(work, Object.assign({}, Emu.profiles.coco3, { id: 'coco3', mame: system }), { basic: loaderRom('floppy') }, system);
writeRoms(work, 'coco_fdc', { 'disk11.rom': new Uint8Array(0x2000).fill(0x39) });
const disk = path.join(work, 'n9.dsk');
const bytes = new Uint8Array(fs.readFileSync(image));
fs.writeFileSync(disk, bytes);
const logFile = path.join(work, 'fdc.log');
const lua = `
local cpu = manager.machine.devices[':maincpu']
local space = cpu.spaces['program']
local out = io.open(${JSON.stringify(logFile)}, 'w')
fdctap = space:install_write_tap(0xff40, 0xff4f, 'fdc', function(offset, data, mask)
  out:write(string.format('%x=%02x\\n', offset, data))
end)
local frames = 0
emu.register_frame_done(function()
  frames = frames + 1
  ${FLOPPY.typed.map((t) => `if frames == ${t.at * 60} then manager.machine.natkeyboard:post(${JSON.stringify(t.text.replace(/\\r/g, '\r'))}) end`).join('\n  ')}
  if frames % 600 == 0 then print(string.format('MAME t=%ds pc=$%04x', frames // 60, cpu.state['PC'].value)) end
  if frames == ${seconds * 60 - 2} then out:flush() manager.machine.video:snapshot() end
end)
`;
const luaFile = path.join(work, 'script.lua');
fs.writeFileSync(luaFile, lua);
const args = [...baseArgs(work, system, luaFile, seconds, true), '-ramsize', '512K', '-ext', 'fdc', '-ext:fdc:wd17xx:0', '525dd', '-flop1', disk];
const r = cp.spawnSync(MAME, args, { env: env(work, true), encoding: 'utf8', timeout: 900000 });
console.log((r.stdout || '').trim());
const writes = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
const snapDir = path.join(work, 'snap');
const shots = fs.existsSync(snapDir) ? fs.readdirSync(snapDir, { recursive: true }).filter((f) => f.endsWith('.png')) : [];
if (pngOut && shots.length) fs.copyFileSync(path.join(snapDir, shots[shots.length - 1]), pngOut);
console.log(`writes=${writes.length} snapshots=${shots.length}`);
if (recordFile) {
  fs.writeFileSync(recordFile, JSON.stringify({
    image: path.basename(image), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mame: mameVersion().text, system, seconds, typed: FLOPPY.typed, writes,
  }, null, 1) + '\n');
}
fs.rmSync(work, { recursive: true, force: true });
