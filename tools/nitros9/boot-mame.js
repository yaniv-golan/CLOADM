#!/usr/bin/env node
// The reference for tools/nitros9/boot.js and tests/nitros9.test.js: the same NitrOS-9 DriveWire image booted in
// MAME 0.264 (coco3h for the 6309, coco3 for the 6809) with our loader (bootdw3.asm) as the internal ROM, the Becker
// port on (cfg) and coco_dwsock connected over TCP 65504 to our DriveWire server (js/drivewire/server.js) serving
// the image. Prints the PC and the DriveWire
// transactions every five seconds and saves MAME's screen at the end.
//   node tools/nitros9/boot-mame.js <image.dsk> [--cpu 6309|6809] [--seconds N] [--png out.png] [--type TEXT --at S]
//        [--record FILE]
// --type posts TEXT (\r for Return) to MAME's keyboard at S seconds (default 15).
// --record writes the run's DriveWire transactions (lib.js record()) as JSON: tests/fixtures/nitros9/ holds them.
const fs = require('fs'), path = require('path'), net = require('net'), cp = require('child_process'), crypto = require('crypto');
const { loadEmu, writeProfileRoms, mameVersion } = require('../mame-diff/lib/firmware');
const { MAME, baseArgs, env } = require('../mame-diff/lib/mame');
const { loaderRom, driveWire } = require('./lib');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const image = argv.find((a) => a.endsWith('.dsk'));
const cpu = opt('--cpu', '6309'), seconds = +opt('--seconds', 60), pngOut = opt('--png', null);
const typeText = opt('--type', null), typeAt = +opt('--at', 15), recordFile = opt('--record', null);
const PORT = 65504;
const luaString = (s) => JSON.stringify(s);   // a JSON string is a valid Lua string for this text

(async () => {
  const Emu = loadEmu();
  const bytes = new Uint8Array(fs.readFileSync(image));
  const { dw, transactions, counts } = await driveWire(Emu, bytes);
  const tcp = net.createServer((sock) => {
    sock.setNoDelay(true);
    let chain = Promise.resolve();
    sock.on('data', (buf) => {
      chain = chain.then(async () => {
        for (const b of buf) { dw.receive(b); while (dw.busy) await dw.busy; }
        if (dw.available) sock.write(Buffer.from(dw.output.splice(0)));
      });
    });
    sock.on('error', () => {});
  });
  await new Promise((resolve) => tcp.listen(PORT, '127.0.0.1', resolve));

  const system = cpu === '6309' ? 'coco3h' : 'coco3';
  const work = `/tmp/mame-diff/nitros9-${system}`;
  fs.rmSync(work, { recursive: true, force: true });
  writeProfileRoms(work, Object.assign({}, Emu.profiles.coco3, { id: 'coco3', mame: system }), { basic: loaderRom() });
  fs.mkdirSync(path.join(work, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(work, 'cfg', `${system}.cfg`), `<?xml version="1.0"?>
<mameconfig version="10">
  <system name="${system}">
    <input>
      <port tag=":beckerport" type="CONFIG" mask="1" defvalue="0" value="1" />
    </input>
  </system>
</mameconfig>
`);
  const lua = `
local cpu = manager.machine.devices[':maincpu']
local frames = 0
emu.register_frame_done(function()
  frames = frames + 1
  if frames % 300 == 0 then print(string.format('MAME t=%ds pc=$%04x', frames // 60, cpu.state['PC'].value)) end
  ${typeText ? `if frames == ${typeAt * 60} then manager.machine.natkeyboard:post(${luaString(typeText.replace(/\\r/g, '\r'))}) end` : ''}
  if frames == ${seconds * 60 - 2} then manager.machine.video:snapshot() end
end)
`;
  const luaFile = path.join(work, 'script.lua');
  fs.writeFileSync(luaFile, lua);
  const args = [...baseArgs(work, system, luaFile, seconds, true), '-ramsize', '512K', '-ext', ''];
  await new Promise((resolve) => {
    const p = cp.spawn(MAME, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env(work, true) });
    p.stdout.on('data', (d) => {
      for (const line of String(d).split('\n').filter(Boolean)) console.log(line, line.startsWith('MAME t=') ? `transactions=${JSON.stringify(counts)}` : '');
    });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 900000);
    p.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  tcp.close();
  const snapDir = path.join(work, 'snap');
  const shots = fs.existsSync(snapDir) ? fs.readdirSync(snapDir, { recursive: true }).filter((f) => f.endsWith('.png')) : [];
  if (pngOut && shots.length) fs.copyFileSync(path.join(snapDir, shots[shots.length - 1]), pngOut);
  console.log(`transactions=${JSON.stringify(counts)} snapshots=${shots.length}`);
  if (recordFile) {
    fs.writeFileSync(recordFile, JSON.stringify({
      image: path.basename(image), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      mame: mameVersion().text, system, seconds, typed: typeText, typedAt: typeAt, transactions,
    }, null, 1) + '\n');
  }
  fs.rmSync(work, { recursive: true, force: true });
})();
