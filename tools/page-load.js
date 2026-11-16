#!/usr/bin/env node
// How long /play/ takes to start over a slow link, and how its module requests are discovered.
// Serves the repository, loads the page in Chromium with a throttled network, and reports the number of
// module requests, the last module request's start time (the waterfall's end) and how long the page takes
// to reach `window.emu.started` (storage open, welcome program running).
//
//   node tools/page-load.js                 three runs, median of each figure
//   node tools/page-load.js --runs 5
//   node tools/page-load.js --latency 200 --kbps 1500     (defaults: 100 ms, 1500 kbit/s)
//   node tools/page-load.js --root /tmp/main-before       serve another copy of the tree (before/after)
//
// A link that is latency-bound (few Mbit/s, 100 ms or more of round-trip) is where the module graph's depth
// shows: with no modulepreload the browser cannot request a module until the one that imports it has
// arrived, so a chain N deep costs N round trips. A fast local loopback hides this completely - measure with
// a throttle or not at all.
//
// Dev tool only, like browser-check.js: needs Playwright, and a machine that is not busy with other heavy
// jobs, or the timings mean little.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const num = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt; };
const str = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const ROOT = path.resolve(str('--root', path.join(__dirname, '..')));
const RUNS = num('--runs', 3), LATENCY = num('--latency', 100), KBPS = num('--kbps', 1500);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const rows = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: LATENCY, downloadThroughput: Math.round(KBPS * 1000 / 8), uploadThroughput: Math.round(KBPS * 1000 / 8),
      });
      const mods = [];
      page.on('request', (r) => { if (/\.js$/.test(new URL(r.url()).pathname)) mods.push(r); });
      const t0 = Date.now();
      await page.goto(base + 'play/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.emu && window.emu.started === true, null, { timeout: 120000 });
      const started = Date.now() - t0;
      const last = await page.evaluate(() => {
        const js = performance.getEntriesByType('resource').filter((e) => /\.js$/.test(e.name));
        // the waterfall's own cost: when the last module was REQUESTED (each round trip delays the next level),
        // and when the first one started. done = every module arrived.
        const starts = js.map((e) => e.startTime);
        const nav = performance.getEntriesByType('navigation')[0] || {};
        return {
          n: js.length,
          first: Math.round(Math.min(...starts)),
          lastStart: Math.round(Math.max(...starts)),
          done: Math.round(Math.max(...js.map((e) => e.responseEnd))),
          pre: document.querySelectorAll('link[rel="modulepreload"]').length,   // Chromium files those requests as initiatorType 'other'
          // how many round trips the transfers take: HTTP/1.1 opens six connections a host, so N requests
          // cost about N/6 round trips however early they are all known
          batches: Math.ceil(js.length / 6),
          // where the rest of the time goes: the document itself, and when the page said it was running
          domEnd: Math.round(nav.domContentLoadedEventEnd || 0),
          loadEnd: Math.round(nav.loadEventEnd || 0),
          bytes: Math.round(js.reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0)),
        };
      });
      rows.push({ modules: last.n, first: last.first, lastStart: last.lastStart, lastModule: last.done, started, pre: last.pre, domEnd: last.domEnd, bytes: last.bytes });
      await ctx.close();
      console.log(`run ${run + 1}: ${last.n} modules (${last.pre} preloaded, ${(last.bytes / 1024).toFixed(0)} KB), first at ${last.first} ms, last requested at ${last.lastStart} ms, all in by ${last.done} ms, DOMContentLoaded ${last.domEnd} ms, started ${started} ms`);
    }
  } finally { await browser.close(); server.close(); }
  const med = (k) => { const s = rows.map((r) => r[k]).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  console.log(`median: ${med('modules')} modules, first ${med('first')} ms, last requested ${med('lastStart')} ms, all in ${med('lastModule')} ms, started ${med('started')} ms  (${RUNS} runs, ${LATENCY} ms RTT, ${KBPS} kbit/s)`);
  // what the "started" figure is made of, so a change in it can be attributed
  console.log(`breakdown of the median: document+first module ${med('first')} ms | modules in flight ${med('lastModule') - med('first')} ms | after the last module: ${med('started') - med('lastModule')} ms`);
  console.log(`  modules: ${med('modules')} over HTTP/1.1's 6 connections a host = about ${Math.ceil(med('modules') / 6)} round trips ` +
    `(${Math.ceil(med('modules') / 6) * LATENCY} ms of latency at ${LATENCY} ms RTT), which is what the transfer figure above is made of`);
})();
