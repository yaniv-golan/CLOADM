#!/usr/bin/env node
// Boot a NitrOS-9 DriveWire image on our CoCo 3 with our loader (js/machines/nitros9.js) as the internal ROM (no Tandy code),
// and report how far it gets: the loader's status ($0100), the PC, the DriveWire transactions and the screen's text, every five
// seconds of emulated time.
//   node tools/nitros9/boot.js <image.dsk> [--cpu 6309|6809] [--seconds N] [--png out.png] [--type TEXT --at S]
// --type types TEXT (\r for Return) at S seconds (default 15) through the keyboard matrix.
const fs = require('fs');
const { loadEmu } = require('../mame-diff/lib/firmware');
const { driveWire, coco3, screenText } = require('./lib');
const { png } = require('../mame-diff/lib/png');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const image = argv.find((a) => a.endsWith('.dsk'));
const cpu = opt('--cpu', '6309'), seconds = +opt('--seconds', 60), pngOut = opt('--png', null);
const typeText = opt('--type', null), typeAt = +opt('--at', 15);

(async () => {
  const Emu = loadEmu();
  const bytes = new Uint8Array(fs.readFileSync(image));
  const { dw, transactions, counts } = await driveWire(Emu, bytes);
  const m = coco3(Emu, cpu, dw);
  const fps = 60, total = seconds * fps;
  let last = '';
  for (let f = 1; f <= total; f++) {
    while (!m.runFrame()) await m.stall;
    if (typeText && f === typeAt * fps) m.typist.type(typeText.replace(/\\r/g, '\r'));
    if (f % (5 * fps) === 0 || f === total) {
      const text = screenText(m).join('\n');
      console.log(`--- t=${f / fps}s pc=$${m.cpu.pc.toString(16)} loader=$${m.read(0x0100).toString(16)} transactions=${JSON.stringify(counts)}`);
      if (text !== last) { console.log(text); last = text; }
    }
  }
  console.log(`first transactions: ${transactions.slice(0, 24).join(' | ')}`);
  if (pngOut) {
    const fr = m.render(), rgba = Emu.frameToRGBA(fr);
    fs.writeFileSync(pngOut, png(fr.width, fr.height, Buffer.from(rgba.buffer)));
  }
})();
