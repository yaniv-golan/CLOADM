// SPIKE: the live view's HTML (cli/panel-view.html) in Chromium, inside a fake MCP Apps host: an outer page frames
// the view as a sandboxed srcdoc iframe (as hosts do), answers ui/initialize, and relays the view's tools/call to a
// real `node cli/cloadm.js --mcp --panel` over stdio. Checks the view draws frames, that typing on its canvas reaches
// the server's machine (screen_text), and reports the frame rate through this relay (an upper bound for a real host).
// Not part of tests/all.js (it needs Chromium). Run: node tests/panel-spike-view.js [--screenshot FILE]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-view-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), '--mcp', '--panel'], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: home }), stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 1;
  const waiting = new Map();
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
  const request = (method, params) => new Promise((ok) => { const k = id++; waiting.set(k, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-host', version: '1' } });
  const html = (await request('resources/read', { uri: 'ui://cloadm/live.html' })).result.contents[0].text;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let appCalls = 0;
  await page.exposeFunction('relay', async (method, params) => { appCalls++; return (await request(method, params)).result; });
  await page.setContent('<iframe id="v" sandbox="allow-scripts" style="width:660px;height:540px;border:0"></iframe>');
  await page.evaluate((src) => {
    const f = document.getElementById('v');
    addEventListener('message', async (e) => {
      const d = e.data;
      if (e.source !== f.contentWindow || !d || d.jsonrpc !== '2.0' || d.id === undefined || !d.method) return;
      const reply = (m) => f.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0', id: d.id }, m), '*');
      if (d.method === 'ui/initialize') return reply({ result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake-host', version: '1' }, hostCapabilities: { serverTools: {} } } });
      // the host's rule: a view may call only tools that list "app" in their visibility (here: the two view tools)
      if (d.method === 'tools/call' && ['view_frame', 'view_keys'].includes(d.params.name)) return reply({ result: await window.relay('tools/call', d.params) });
      reply({ error: { code: -32601, message: `refused: ${d.method} ${d.params && d.params.name}` } });
    });
    f.srcdoc = src;
  }, html);
  const view = page.frameLocator('#v');
  await page.waitForTimeout(3000);
  const status1 = await view.locator('#st').textContent();
  await view.locator('#screen').click();
  await page.keyboard.type('I AM HAPPY');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  const status2 = await view.locator('#st').textContent();
  const shot = process.argv.indexOf('--screenshot');
  if (shot > 0) await page.screenshot({ path: process.argv[shot + 1] });
  const screen = JSON.stringify((await request('tools/call', { name: 'screen_text', arguments: { machine_id: 'm1' } })).result.structuredContent);
  await browser.close();
  child.stdin.end();
  fs.rmSync(home, { recursive: true, force: true });

  let fail = 0;
  const check = (name, cond, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${cond ? '' : detail}`); };
  check('no page errors', errors.length === 0, errors.join('; '));
  check('the view is connected and drawing frames of m1', /^m1 · [\d.]+ view frames\/s/.test(status1), status1);
  check('typing on the view reached the server\'s machine', screen.includes('I AM HAPPY'), screen.slice(0, 300));
  console.log(`status: ${status2}; ${appCalls} tool calls relayed`);
  process.exitCode = fail ? 1 : 0;
})();
