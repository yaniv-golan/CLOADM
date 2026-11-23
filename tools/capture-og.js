#!/usr/bin/env node
// The link preview picture (og:image / twitter:image of index.html and play/index.html): img/og.png, 1200x630.
// The welcome program's menu, captured from the real page in Chromium with NO ROMs loaded (the welcome program runs on
// the built-in stub, so no pixel comes from a ROM: the capture refuses if the machine has one), drawn into a CRT
// bezel beside the name, in the site's own colours and fonts (css/tokens.css).
//   node tools/capture-og.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'img', 'og.png');
const W = 1200, H = 630;
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
    const url = await page.evaluate(async ([W, H]) => {
      await document.fonts.load('800 64px Archivo'); await document.fonts.load('400 26px "JetBrains Mono"'); await document.fonts.load('400 30px Archivo');
      // the emulated picture itself, at its own pixels
      const f = window.emu.machine.render(), src = document.createElement('canvas');
      src.width = f.width; src.height = f.height;
      const img = new ImageData(f.width, f.height), px = new Uint32Array(img.data.buffer);
      for (let i = 0; i < f.data.length; i++) px[i] = f.table[f.data[i]];
      src.getContext('2d').putImageData(img, 0, 0);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
      // the ground, and the phosphor's glow behind the monitor
      g.fillStyle = '#0B0D0C'; g.fillRect(0, 0, W, H);
      const glow = g.createRadialGradient(370, 300, 40, 370, 300, 420);
      glow.addColorStop(0, 'rgba(61,245,90,0.22)'); glow.addColorStop(1, 'rgba(11,13,12,0)');
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
      // the monitor: a bezel, the glass, then the picture (4:3, nearest-neighbour)
      const bx = 50, by = 55, bw = 640, bh = 520;
      g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 50; g.shadowOffsetY = 30;
      const bez = g.createLinearGradient(0, by, 0, by + bh); bez.addColorStop(0, '#3A3F3D'); bez.addColorStop(1, '#1C201E');
      g.fillStyle = bez; rr(bx, by, bw, bh, [44, 44, 32, 32]); g.fill(); g.restore();
      const gx = bx + 34, gy = by + 34, gw = bw - 68, gh = bh - 68;
      g.fillStyle = '#000'; rr(gx, gy, gw, gh, [36, 36, 36, 36]); g.fill();
      const sw = 512, sh = 384, sx = gx + (gw - sw) / 2, sy = gy + (gh - sh) / 2;
      g.imageSmoothingEnabled = false;
      g.save(); g.shadowColor = 'rgba(61,245,90,0.35)'; g.shadowBlur = 40; g.drawImage(src, sx, sy, sw, sh); g.restore();
      // the glass's curve over the picture: dark at the corners
      const vig = g.createRadialGradient(gx + gw / 2, gy + gh / 2, gh * 0.35, gx + gw / 2, gy + gh / 2, gw * 0.62);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = vig; rr(gx, gy, gw, gh, 36); g.fill();
      // the name and what it is
      const tx = 740;
      g.fillStyle = '#3DF55A'; g.fillRect(tx, 190, 22, 22); g.fillRect(tx, 214, 22, 22); g.fillRect(tx + 24, 214, 22, 22);
      g.fillStyle = '#003B00'; g.fillRect(tx + 24, 190, 22, 22);
      g.fillStyle = '#F2F1EA'; g.font = '800 64px Archivo'; g.textBaseline = 'alphabetic'; g.fillText('CLOADM', tx, 310);
      g.font = '400 30px Archivo'; g.fillStyle = '#C9CCC4';
      ['Dragon and Tandy Color', 'Computer emulator,', 'in your browser.'].forEach((l, i) => g.fillText(l, tx, 365 + i * 40));
      g.font = '400 22px "JetBrains Mono"'; g.fillStyle = '#8A918A'; g.fillText('cloadm.dev', tx, 520);
      // the eight artifact colours, the site's stripe
      ['#30D82B', '#F2EA4A', '#2A35E8', '#D8202A', '#EDE6C8', '#2BD8D8', '#D02BD8', '#F08A1F'].forEach((col, i) => { g.fillStyle = col; g.fillRect(i * W / 8, H - 8, W / 8, 8); });
      return c.toDataURL('image/png');
    }, [W, H]);
    fs.writeFileSync(OUT, Buffer.from(url.split(',')[1], 'base64'));
    console.log(path.relative(ROOT, OUT));
  } finally {
    await browser.close();
    server.close();
  }
})();
