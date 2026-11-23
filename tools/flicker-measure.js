// What a page load costs the DOM: a .cas dropped with ROMs stored (the "Using your ROMs again" path, which restarts
// into BASIC and loads through it), in a fresh profile (no storage, no service worker yet) and in one that has
// visited before. Reports, per second of the load and in all: DOM mutations, layout shifts, canvas element
// replacements, service-worker events, navigations, reloads, and the inline-style writes on #toastRegion (where a
// toast's placement loop shows; see docs/development.md, "The page's per-frame work").
//
// Usage: node tools/flicker-measure.js [--runs N] [--out DIR]
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.join(__dirname, '..');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// a machine-code .cas (type 2), built here: leader, header, data, end block
const block = (t, d) => { let s = (t + d.length) & 255; for (const v of d) s = (s + v) & 255; return [0x3C, t, d.length, ...d, s, 0x55]; };
function cas() {
  const nf = [...Buffer.from('TEST    '), 2, 0, 0, 0x40, 0x40, 0x03, 0x00];
  const out = [...new Array(128).fill(0x55), ...block(0, nf), ...new Array(128).fill(0x55), ...block(1, [0x20, 0xFE]), ...block(0xFF, [])];
  return Uint8Array.from(out);
}
// the reset-firmware stand-in ROMs (tests/fixtures/reset-firmware.js), so a drop has stored ROMs that boot BASIC
const Emu = require(path.join(ROOT, 'tests', 'load'))();
const { build } = require(path.join(ROOT, 'tests', 'fixtures', 'reset-firmware'));
const { basic, basic64 } = build(Emu);

// the instrumentation, installed before any page script runs
const INIT = `
window.__flick = { mut: 0, shift: 0, cls: 0, canvases: 0, sw: [], reloads: 0, samples: [], t0: performance.now(), regionWrites: 0 };
// the toast region's inline-style writes: a MutationObserver on attributes, filtered to the one element
new MutationObserver((recs) => { for (const r of recs) if (r.type === 'attributes' && r.target && r.target.id === 'toastRegion' && r.attributeName === 'style') window.__flick.regionWrites++; })
  .observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
new MutationObserver((recs) => { window.__flick.mut += recs.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__flick.shift += e.value; window.__flick.cls++; } })
  .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}   // (one observer: counting cls twice would double it)
new MutationObserver((recs) => {
  for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.id === 'screen' || n.tagName === 'CANVAS')) window.__flick.canvases++;
}).observe(document, { subtree: true, childList: true });
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => window.__flick.sw.push('controllerchange'));
  navigator.serviceWorker.getRegistration && navigator.serviceWorker.getRegistration().then((r) => { if (r) { window.__flick.sw.push('registered'); r.addEventListener('updatefound', () => window.__flick.sw.push('updatefound')); } });
}
window.addEventListener('beforeunload', () => { window.__flick.reloads++; });
// a per-second sampler
setInterval(() => { const f = window.__flick; const now = performance.now(); f.samples.push({ at: Math.round(now - f.t0), mut: f.mut, shift: +f.shift.toFixed(5), cls: f.cls, canvases: f.canvases }); }, 1000);
`;
// on a reload the counter must survive: keep it in sessionStorage (the page's own reload case)
const PERSIST = `
try { if (sessionStorage.getItem('__flickR')) { const r = JSON.parse(sessionStorage.getItem('__flickR')); window.__flick.reloads = r.reloads; window.__flick.sw = r.sw; } } catch (e) {}
setInterval(() => { try { sessionStorage.setItem('__flickR', JSON.stringify({ reloads: window.__flick.reloads, sw: window.__flick.sw })); } catch (e) {} }, 500);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneRun(base, { fresh, label, dir: reuse }) {
  // a brand-new profile (no storage, no service worker) for a first visit; a REPEAT visit reuses the SAME directory, so
  // it really meets the storage and the service worker its previous visit left. (A fresh mkdtemp for the "repeat" case
  // measured another first visit.)
  // The caller allocates ONE directory per run and passes it in for both visits, so the repeat lands on what the first
  // left. (`fresh || !reuse` here made the first visit allocate its own, so the caller's directory was never written and
  // the repeat got a brand-new one: measured as two profiles and swControlledAtLoad=false on both.)
  const dir = reuse;   // (the caller always allocates one per run and passes it to both visits)
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT + PERSIST);
  // PROBE: was this page already controlled by a service worker at load (a true repeat visit), or not (a first install)?
  await ctx.addInitScript(() => { window.__swAtLoad = navigator.serviceWorker ? !!navigator.serviceWorker.controller : null; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const navigations = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(Date.now()); });
  await page.goto(`${base}?machine=dragon64`);
  await page.waitForFunction(() => window.emu && window.emu.ready && window.emu.started, null, { timeout: 30000 });
  // let the visit settle (the welcome menu, the service worker's first install)
  await sleep(3000);
  // stored ROMs, then choose to run without them: the precondition for the path this measures
  await page.evaluate(([a, b]) => window.emu.session.addRoms([{ name: 'd64_1.rom', bytes: Uint8Array.from(a) }, { name: 'd64_2.rom', bytes: Uint8Array.from(b) }]),
    [[...basic], [...basic64]]);
  await page.evaluate(() => window.emu.session.runWithoutRoms({ menu: false }));
  await sleep(1500);
  // ---- the measured window: drop the tape and wait for the load to finish ----
  const before = await page.evaluate(() => ({ ...window.__flick, samples: [], t0: performance.now() }));
  const nav0 = navigations.length;
  await page.evaluate(async ([bytes]) => {
    const f = new File([new Uint8Array(bytes)], 'load-measure.cas');
    const dt = new DataTransfer(); dt.items.add(f);
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    document.getElementById('screenWrap').dispatchEvent(ev);
  }, [[...cas()]]);
  // the load has finished: the machine is running the ROMs that were dropped with it. (The regex here tested the toast's
  // text for a wording that no longer exists and was ANDed away by the trailing `|| s.machine.hasRom`, so it could never
  // decide anything; and a `.catch` hid a 30 s timeout, which turned "the load never finished" into a passing run.)
  try {
    await page.waitForFunction(() => !!(window.emu.session.machine.hasRom), null, { timeout: 30000 });
  } catch (e) {
    throw new Error('the dropped tape never loaded (no ROM-backed machine within 30 s); the measurement is not valid');
  }
  await sleep(6000);
  const swAtLoad = await page.evaluate(() => window.__swAtLoad);
  const after = await page.evaluate((t0) => ({ ...window.__flick, windowMs: performance.now() - t0 }), before.t0);
  console.log(`  [probe] ${label}: profile=${dir} swControlledAtLoad=${swAtLoad}`);
  await ctx.close();
  // (the caller removes the profile once both visits of a run are done; deleting it here would wipe the repeat's state)
  // the window runs from `before` (its own t0) to `after`; `samples[].at` is measured from PAGE LOAD, so subtracting
  // the last sample's `at` from it would count the pages of setup before the window. The window's own length is the
  // time between the two performance.now() readings.
  const secs = Math.max(1, Math.round((after.windowMs ?? 0) / 1000));
  const dMut = after.mut - before.mut, dShift = +(after.shift - before.shift).toFixed(5), dCls = after.cls - before.cls;
  const canv = after.canvases - before.canvases;
  return { label, fresh, seconds: secs, mutations: dMut, mutationsPerSec: Math.round(dMut / secs), layoutShifts: dCls, cls: dShift,
    // #toastRegion's style-attribute writes in the window: main rewrote it every animation frame
    regionWrites: after.regionWrites - before.regionWrites,
    canvasElements: canv, reloads: after.reloads, sw: after.sw.slice(0, 5), navigations: navigations.length - nav0, errors,
    samples: after.samples };
}

async function main() {
  // Arguments are read by name, never by `Number(args[index + 1])`: with only `--out DIR` given, that expression read
  // the NEXT argument (`--out`'s value) and produced NaN, so the tool did no runs and wrote an empty file.
  const args = process.argv.slice(2);
  const valueOf = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] ?? null; };
  const runsArg = valueOf('--runs');
  const runs = runsArg === null ? 3 : Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`flicker-measure: --runs needs a whole number of runs, at least 1 (got ${JSON.stringify(runsArg)}). Omit it for the default of 3.`);
    process.exitCode = 2;
    return;
  }
  const out = valueOf('--out') ?? path.join(os.tmpdir(), 'cloadm-load-measure');
  fs.mkdirSync(out, { recursive: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/play/`;
  const results = [];
  for (let i = 0; i < runs; i++) {
    // ONE profile per run: the first-visit case creates it, the repeat-visit case REUSES it, so the repeat really meets
    // the storage and service worker the first visit left behind.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-load-'));
    for (const fresh of [true, false]) {
      const r = await oneRun(base, { fresh, dir, label: `run${i + 1}-${fresh ? 'first-visit' : 'repeat-visit'}` });
      results.push(r);
      console.log(`${r.label}: ${r.seconds}s, mutations ${r.mutations} (${r.mutationsPerSec}/s), layout shifts ${r.layoutShifts} (CLS ${r.cls}), canvas elements ${r.canvasElements}, reloads ${r.reloads}, navs ${r.navigations}, sw ${JSON.stringify(r.sw)}${r.errors.length ? ', errors ' + r.errors.join(' | ') : ''} | toastRegion style writes ${r.regionWrites}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  server.close();
  fs.writeFileSync(path.join(out, 'flicker.json'), JSON.stringify(results, null, 2));
  console.log(`written: ${path.join(out, 'flicker.json')}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
