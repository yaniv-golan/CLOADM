#!/usr/bin/env node
// The link preview picture (og:image / twitter:image of index.html and play/index.html): img/og.png, 1200x630, at most
// 16 colours. The welcome program's menu, captured from the real page in Chromium with NO ROMs loaded (the welcome
// program runs on the built-in stub, so no pixel comes from a ROM: the capture refuses if the machine has one), made
// into the card by js/video/bezel.js (renderBezelCard: the CRT bezel, "cloadm.dev" on it, the name beside it, over the
// shared js/video/card.js and js/media/png.js).
//   node tools/capture-og.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { renderBezelCard } = require('../js/video/bezel.js');
const { Frame } = require('../js/video/frame.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'img', 'og.png');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const waitFor = async (page, fn) => { for (let i = 0; i < 200; i++) { if (await page.evaluate(fn)) return; await page.waitForTimeout(50); } throw new Error(`timed out: ${fn}`); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/play/?machine=dragon64&start=welcome`);
    await waitFor(page, () => window.emu && window.emu.machine && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 5'));
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.emu.machine.hasRom)) throw new Error('ROMs loaded: refusing to capture');
    // the emulated picture itself (colour codes and their table), drawn into the card here in Node
    const f = await page.evaluate(() => { const f = window.emu.machine.render(); return { width: f.width, height: f.height, aspect: f.aspect, active: f.active, data: [...f.data], table: [...f.table] }; });
    const frame = new Frame(f.width, f.height, f.aspect, f.active);
    frame.data.set(f.data); frame.table.set(f.table);
    const png = await renderBezelCard(frame);
    fs.writeFileSync(OUT, png);
    console.log(path.relative(ROOT, OUT));
  } finally {
    await browser.close();
    server.close();
  }
})();
