#!/usr/bin/env node
// Captures img/readme-demo.gif for the README: the welcome menu, then LIZA answering, from the real page in
// Chromium with no ROMs loaded (the built-in firmware runs both, so no ROM screen is ever published). Frames are the
// emulator's own picture at 2x with square pixels, encoded by js/media/gif.js.
//   node tools/capture-gif.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'img', 'readme-demo.gif'), K = 2;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const waitFor = async (page, fn) => { for (let i = 0; i < 200; i++) { if (await page.evaluate(fn)) return; await page.waitForTimeout(50); } throw new Error(`timed out: ${fn}`); };
// one frame: the machine's rendered picture as RGB bytes at native size
const grab = (page) => page.evaluate(() => {
  const f = window.emu.machine.render(), rgb = new Uint8Array(f.width * f.height * 3);
  for (let i = 0; i < f.data.length; i++) { const c = f.table[f.data[i]]; rgb[i * 3] = c & 255; rgb[i * 3 + 1] = c >> 8 & 255; rgb[i * 3 + 2] = c >> 16 & 255; }
  return { w: f.width, h: f.height, rgb: Array.from(rgb) };
});

(async () => {
  const { encodeGif } = await import('../js/media/gif.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/play/`;
  const browser = await chromium.launch();
  const shots = []; // { rgb, delay }
  const snap = async (page, delay) => { const s = await grab(page); shots.push({ ...s, delay }); };
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${base}?machine=dragon64&start=welcome`);
    await waitFor(page, () => window.emu && window.emu.machine && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 5'));
    if (await page.evaluate(() => window.emu.machine.hasRom)) throw new Error('ROMs loaded: refusing to capture');
    await page.waitForTimeout(300);
    await snap(page, 200);              // the menu, held
    await page.focus('#screen');
    await page.keyboard.press('1');
    await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
    await page.waitForTimeout(300);
    await snap(page, 150);
    for (const line of ['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC']) {
      for (const ch of line) { await page.keyboard.type(ch); if (ch === ' ' || ch === line[line.length - 1]) await snap(page, ch === line[line.length - 1] ? 60 : 10); }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(900);
      await snap(page, 220);
    }
  } finally { await browser.close(); server.close(); }

  // palette from the colours that occur, frames scaled K x with square pixels
  const colours = new Map();
  for (const s of shots) for (let i = 0; i < s.rgb.length; i += 3) { const k = s.rgb[i] << 16 | s.rgb[i + 1] << 8 | s.rgb[i + 2]; if (!colours.has(k)) colours.set(k, colours.size); }
  if (colours.size > 256) throw new Error(`${colours.size} colours`);
  const palette = [...colours.keys()].map((k) => [k >> 16 & 255, k >> 8 & 255, k & 255]);
  const { w, h } = shots[0];
  const frames = shots.map((s) => {
    const px = new Uint8Array(w * K * h * K);
    for (let y = 0; y < h * K; y++) for (let x = 0; x < w * K; x++) {
      const i = ((y / K | 0) * w + (x / K | 0)) * 3;
      px[y * w * K + x] = colours.get(s.rgb[i] << 16 | s.rgb[i + 1] << 8 | s.rgb[i + 2]);
    }
    return { pixels: px, delay: s.delay };
  });
  const gif = encodeGif({ width: w * K, height: h * K, palette, frames });
  fs.writeFileSync(OUT, gif);
  console.log(`img/readme-demo.gif ${w * K}x${h * K}, ${frames.length} frames, ${gif.length} bytes`);
})();
