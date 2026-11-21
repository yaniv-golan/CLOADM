// SPIKE (claude/plugin-live-panel-spike): the local stdio server's live view (cli/panel.js, `--mcp --panel`), as an
// MCP client sees it, with no browser:
//  * initialize advertises the MCP Apps extension (io.modelcontextprotocol/ui) and resources;
//  * tools/list has open_emulator with _meta.ui.resourceUri, and view_frame / view_keys marked app-only;
//  * resources/list and resources/read serve the view (text/html;profile=mcp-app), which fetches nothing;
//  * the view's tools drive the same machine as the model's: typing through view_keys shows in screen_text, and a
//    frame through view_frame is a PNG of it;
//  * without --panel none of this exists (resources/list is method not found).
// The browser part (the view's HTML in Chromium under a fake host) is tests/panel-spike-view.js.
// Run: node tests/panel-spike.test.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = (v) => JSON.stringify(v).slice(0, 400);

function server(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-panel-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), '--mcp', ...args], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: home }), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 1;
  const waiting = new Map();
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  });
  return {
    request: (method, params) => new Promise((ok) => { const k = id++; waiting.set(k, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); }),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    close: () => new Promise((ok) => { child.on('close', () => { fs.rmSync(home, { recursive: true, force: true }); ok(); }); child.stdin.end(); }),
  };
}

(async () => {
  const s = server(['--panel']);
  const init = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'panel-spike', version: '1' } });
  s.notify('notifications/initialized', {});
  const caps = init.result.capabilities;
  check('initialize: the MCP Apps extension with its MIME type, and resources', J(caps.extensions) === J({ 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }) && caps.resources && caps.tools, J(caps));

  const tools = (await s.request('tools/list', {})).result.tools;
  const t = (name) => tools.find((x) => x.name === name);
  check('tools/list: open_emulator points at the view', t('open_emulator') && t('open_emulator')._meta.ui.resourceUri === 'ui://cloadm/live.html' && !t('open_emulator')._meta.ui.visibility, J(t('open_emulator')));
  check('tools/list: view_frame and view_keys are app-only', ['view_frame', 'view_keys'].every((x) => t(x) && J(t(x)._meta.ui.visibility) === J(['app'])), J(tools.map((x) => x.name)));
  check('tools/list: the machine tools are still there, without a view', ['boot', 'type_text', 'screen_text', 'insert_tape', 'save_snapshot'].every((x) => t(x) && !(t(x)._meta && t(x)._meta.ui)));

  const list = (await s.request('resources/list', {})).result.resources;
  check('resources/list: the view, with the MCP Apps MIME type', list.length === 1 && list[0].uri === 'ui://cloadm/live.html' && list[0].mimeType === 'text/html;profile=mcp-app', J(list));
  const read = (await s.request('resources/read', { uri: 'ui://cloadm/live.html' })).result.contents[0];
  check('resources/read: HTML with the MIME type', read.mimeType === 'text/html;profile=mcp-app' && /^<!doctype html>/i.test(read.text), J(read).slice(0, 200));
  check('resources/read: the view speaks the bridge (ui/initialize, then tools/call to view_frame and view_keys)', read.text.includes("'ui/initialize'") && read.text.includes("'tools/call'") && read.text.includes("'view_frame'") && read.text.includes("'view_keys'"));
  check('resources/read: it fetches nothing from anywhere (no http URL, no CSP needed)', !/https?:\/\//.test(read.text) && !(read._meta && read._meta.ui && read._meta.ui.csp));
  const unknown = await s.request('resources/read', { uri: 'ui://cloadm/nope.html' });
  check('resources/read: an unknown resource is an error', unknown.error && unknown.error.code === -32602, J(unknown));

  const open = (await s.request('tools/call', { name: 'open_emulator', arguments: {} })).result;
  check('open_emulator: a text result for the model', !open.isError && /live view/.test(open.content[0].text), J(open));

  const f1 = (await s.request('tools/call', { name: 'view_frame', arguments: {} })).result;
  const id = f1.structuredContent && f1.structuredContent.machine_id;
  const png = f1.content.find((c) => c.type === 'image');
  check('view_frame with no machine: boots one, returns its id and a PNG', id === 'm1' && png && png.mimeType === 'image/png' && Buffer.from(png.data, 'base64').subarray(1, 4).toString() === 'PNG', J(f1).slice(0, 200));
  const machines = (await s.request('tools/call', { name: 'list_machines', arguments: {} })).result.structuredContent.machines;
  check('the model sees the machine the view booted', machines.length === 1 && machines[0].machine_id === 'm1', J(machines));

  await s.request('tools/call', { name: 'load', arguments: { machine_id: 'm1', program: 'liza' } });
  await s.request('tools/call', { name: 'run_frames', arguments: { machine_id: 'm1', frames: 100 } });
  const k = (await s.request('tools/call', { name: 'view_keys', arguments: { text: 'I AM HAPPY\n' } })).result;
  check('view_keys: the person\'s typing goes to the newest machine', !k.isError && k.structuredContent.machine_id === 'm1', J(k));
  await new Promise((r) => setTimeout(r, 120));
  const f2 = (await s.request('tools/call', { name: 'view_frame', arguments: { machine_id: 'm1' } })).result;
  check('view_frame: runs the machine for the real time since the last frame (at most 10 frames)', !f2.isError && f2.structuredContent.frames_run >= 1 && f2.structuredContent.frames_run <= 10, J(f2.structuredContent));
  const text = (await s.request('tools/call', { name: 'screen_text', arguments: { machine_id: 'm1' } })).result.structuredContent;
  check('the model reads what the person typed in the view (one machine, not two)', JSON.stringify(text).includes('I AM HAPPY'), J(text));
  const bad = (await s.request('tools/call', { name: 'view_frame', arguments: { machine_id: 'm9' } })).result;
  check('view_frame on a machine that is not there: the toolbox\'s refusal', bad.isError && bad.structuredContent.error.code, J(bad));
  await s.close();

  const plain = server([]);
  await plain.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const plainTools = (await plain.request('tools/list', {})).result.tools;
  const plainRes = await plain.request('resources/list', {});
  check('without --panel: no view tools, no resources', !plainTools.some((x) => x.name === 'open_emulator' || x.name === 'view_frame') && plainRes.error && plainRes.error.code === -32601, J(plainRes));
  await plain.close();

  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})();
