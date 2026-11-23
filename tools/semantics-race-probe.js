// Does the semantics text-alternative check race a screen that is still CHANGING?
//
// The check reads `screenAlternative()` (the LIVE screen), then Chromium's accessibility tree over CDP, then the
// live screen again, and the page's `#screenAlt` mirror alongside - four readings that must agree. The prototype
// it replaced compared one live read against the AX text in a single shot, and `#screenAlt` is refreshed by the
// page at most once a second (js/ui/screen.js), so both readings can straddle a change. This probe starts LIZA
// exactly as the check does and samples, every 20 ms for 3 s, the live text AND the mirror, so we can see whether
// the screen is still moving (a typewriter greeting) and how far the mirror lags it.
//
//   node tools/semantics-race-probe.js [outfile] [cpuThrottle]
//
// cpuThrottle (default 1) is CDP's Emulation.setCPUThrottlingRate: 4 stands in for a slow CI runner, where the
// greeting is still typing for longer and the mirror's 1 s refresh covers a bigger share of the change.
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require('playwright');

// a static server for the repo, same as browser-check's
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, u.endsWith('/') ? `${u}index.html` : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const type = /\.js$/.test(f) ? 'text/javascript' : /\.html?$/.test(f) ? 'text/html' : /\.css$/.test(f) ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  const out = process.argv[2] || require('path').join(require('os').tmpdir(), 'cloadm-semantics-race.txt');
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/play/`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const throttle = +(process.argv[3] || 1);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      say(`cpu throttled x${throttle}`);
    }
    await page.goto(`${base}?machine=dragon64`);
    // ready + started, as the check does
    for (let i = 0; i < 400; i++) {
      if (await page.evaluate(() => !!(window.emu && window.emu.ready === true)).catch(() => false)) break;
      await page.waitForTimeout(50);
    }
    for (let i = 0; i < 400; i++) {
      const t = await page.evaluate(() => window.emu && window.emu.session ? window.emu.session.screenAlternative() : '').catch(() => '');
      if (/TALK TO LIZA/.test(t)) break;
      await page.waitForTimeout(50);
    }
    // emulate a starved CI runner: the emulation runs slower, so the greeting may still be TYPING while the check
    // reads. --throttle N multiplies the CPU cost of the page (CDP Emulation.setCPUThrottlingRate).
    // LIZA from the menu, exactly as the check does it
    await page.click('#screen');
    await page.keyboard.press('1');
    // then sample the alternative every 20 ms for 3 s
    const samples = await page.evaluate(async () => {
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        // BOTH the live screen and the DOM's stale copy: the check compares those two
        out.push([Math.round(performance.now() - t0), window.emu.session.screenAlternative(),
          (document.getElementById('screenAlt') || {}).textContent || '']);
        await new Promise((r) => setTimeout(r, 20));
      }
      return out;
    });
    const vals = samples.map((s) => s[1]);
    const dom = samples.map((s) => s[2]);
    say(`distinct DOM (#screenAlt) values: ${new Set(dom).size}`);
    let stale = 0; for (let i = 0; i < vals.length; i++) if (vals[i] !== dom[i]) stale++;
    say(`samples where live screen != #screenAlt (the DOM updates once a second): ${stale}/${vals.length}`);
    const distinct = [...new Set(vals)];
    say(`samples: ${vals.length} over 3 s`);
    say(`distinct screenAlternative values: ${distinct.length}`);
    // where does it change, and what changes?
    let changes = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1]) changes++;
    say(`transitions: ${changes}`);
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i - 1]) continue;
      const a = vals[i - 1], b = vals[i];
      let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
      say(`  at ${samples[i][0]} ms: differ from char ${k}: ...${JSON.stringify(a.slice(Math.max(0, k - 8), k + 20))} -> ...${JSON.stringify(b.slice(Math.max(0, k - 8), k + 20))}`);
    }
    say(`lengths: first ${vals[0].length}, last ${vals[vals.length - 1].length}, min ${Math.min(...vals.map((v) => v.length))}, max ${Math.max(...vals.map((v) => v.length))}`);
    say(`page errors: ${errors.length ? errors.join('; ') : 'none'}`);
    fs.writeFileSync(out, lines.join('\n') + '\n');
    say(`written to ${out}`);
  } finally {
    await browser.close();
    server.close();
  }
})();
