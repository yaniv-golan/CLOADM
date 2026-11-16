#!/usr/bin/env node
// Captures the site's pictures of the emulator from the real page in Chromium, with no ROMs loaded (the
// welcome program and LIZA run on the built-in stub), so no ROM boot screen is ever published:
//   img/welcome.png  the welcome program's menu (landing page hero, README)
//   img/liza.png     a short LIZA conversation (landing page, README)
// Each is the emulator canvas at its native resolution; pages scale it with image-rendering: pixelated. The
// README gets copies scaled 2x with square pixels (img/readme-*.png), since GitHub scales images smoothly.
//   node tools/capture-images.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const save = async (page, name, scale = 1) => {
  const url = await page.evaluate((k) => {
    // the emulated picture itself (the page's canvas has the size and look the Display tab gives it)
    const f = window.emu.machine.render(), src = document.createElement('canvas');
    src.width = f.width; src.height = f.height;
    const img = new ImageData(f.width, f.height), px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < f.data.length; i++) px[i] = f.table[f.data[i]];
    src.getContext('2d').putImageData(img, 0, 0);
    const c = document.createElement('canvas');
    c.width = f.width * k; c.height = f.height * k;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, scale);
  fs.mkdirSync(path.join(ROOT, 'img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'img', name), Buffer.from(url.split(',')[1], 'base64'));
  console.log(`img/${name}`);
};
const waitFor = async (page, fn) => { for (let i = 0; i < 200; i++) { if (await page.evaluate(fn)) return; await page.waitForTimeout(50); } throw new Error(`timed out: ${fn}`); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/play/`;
  const browser = await chromium.launch();
  try {
    let page = await (await browser.newContext()).newPage();
    await page.goto(`${base}?machine=dragon64&start=welcome`);
    await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'));
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.emu.machine.hasRom)) throw new Error('ROMs loaded: refusing to capture');
    await save(page, 'welcome.png');
    await save(page, 'readme-welcome.png', 2);
    page = await (await browser.newContext()).newPage();
    await page.goto(`${base}?machine=dragon64&start=liza`);
    await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
    await page.focus('#screen');
    for (const line of ['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC']) {
      await page.keyboard.type(line, { delay: 40 }); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
    }
    await save(page, 'liza.png');
    await save(page, 'readme-liza.png', 2);
  } finally {
    await browser.close();
    server.close();
  }
})();
