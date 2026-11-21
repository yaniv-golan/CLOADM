// The MCP Apps bridge of CLOADM's side-panel view: a CLASSIC script, inlined in the view's HTML (connector/build.js)
// before the emulator's module, so it shakes hands with the host as soon as the HTML is parsed, before the emulator's
// code is fetched (variant A) or evaluated (variant B, about 1 MiB) and before storage opens. A view that did its
// handshake only after all that was shown by Claude without its app tools ever being listed; this order is what made
// them work on claude.ai (spike, branch claude/spike-mcp-sidepanel-selfhost).
// Protocol (ext-apps specification/2026-01-26/apps.mdx, JSON-RPC 2.0 over postMessage with the host):
//  * the view sends ui/initialize (appCapabilities.tools.listChanged: true), then ui/notifications/initialized;
//  * the host asks tools/list (answered at once, from the list the build put in CLOADM_VIEW.tools) and sends
//    tools/call (a call that comes before the emulator is ready waits for it, EARLY_WAIT_MS at most);
//  * when the emulator attaches, its own list replaces the build's and the view sends notifications/tools/list_changed.
// The emulator's module plugs in with CLOADM_BRIDGE.attach({ api, tools, call(name, args, { signal }) -> result }).
// `api` must equal CLOADM_VIEW.api, the contract between this view (the Worker's build) and the module (served by
// cloadm.dev in variant A): when they differ, every call is refused with out-of-step rather than half working.
// CLOADM_BRIDGE.fail(why) says the emulator could not start: calls are then answered at once with not-started.
(() => {
  const cfg = window.CLOADM_VIEW || {};
  const EARLY_WAIT_MS = 15000;   // with the tools' own 25 s limit, inside the host's 45 s per call
  const host = window.parent;
  let rid = 1;
  const waiting = new Map(), running = new Map();
  const send = (m) => host.postMessage(Object.assign({ jsonrpc: '2.0' }, m), '*');
  const rpc = (method, params) => new Promise((ok, no) => { const id = rid++; waiting.set(id, { ok, no }); send({ id, method, params }); });
  // an error in the toolbox's shape ({ code, remedy, detail }), as an MCP tool result
  const refusal = (code, remedy, detail) => ({ content: [{ type: 'text', text: JSON.stringify({ error: { code, remedy, detail } }) }], structuredContent: { error: { code, remedy, detail } }, isError: true });
  const log = { t0: Date.now(), initSent: null, initSentAt: null, init: null, initialized: null, lists: 0, calls: 0, changed: null, other: [] };
  const ms = () => Date.now() - log.t0;
  let impl = null, failed = null, tools = Array.isArray(cfg.tools) ? cfg.tools : [];
  let settle;
  const ready = new Promise((r) => { settle = r; });
  const listeners = [];
  const changed = () => listeners.forEach((fn) => fn());
  // once both the handshake and the emulator are done, whichever comes last, the host is told the tools changed
  const listChanged = () => { if (log.changed !== null) return; log.changed = ms(); send({ method: 'notifications/tools/list_changed', params: {} }); changed(); };
  const B = window.CLOADM_BRIDGE = {
    log, host: null,
    get failed() { return failed; },
    describe: () => `bridge: init ${log.init === null ? 'pending' : typeof log.init === 'number' ? `${log.init} ms` : log.init}, tools/list ×${log.lists}, calls ×${log.calls}, list_changed ${log.changed === null ? 'not sent' : 'sent'}${failed ? `, ${failed.code}` : ''}${log.other.length ? `, other ${log.other.join(' ')}` : ''}`,
    onChange: (fn) => listeners.push(fn),
    attach(x) {
      if (impl || failed) return false;
      if (!x || x.api !== cfg.api) {
        failed = { code: 'out-of-step', detail: `this connector's view speaks panel API ${cfg.api}, the emulator code it loaded speaks ${x && x.api}` };
        settle(); changed(); return false;
      }
      impl = x;
      if (Array.isArray(x.tools)) tools = x.tools;
      settle();
      if (log.initialized !== null) listChanged();
      changed();
      return true;
    },
    fail(why) { if (impl || failed) return; failed = { code: 'not-started', detail: String(why) }; settle(); changed(); },
    requestDisplayMode: (mode) => rpc('ui/request-display-mode', { mode }),
  };
  const REMEDY = {
    'not-started': 'the emulator in the panel could not start (detail says why): ask the person to reopen the view, or open it with open_emulator_inline, which needs nothing from cloadm.dev',
    'out-of-step': 'the connector and the cloadm.dev site are from different releases: open the view with open_emulator_inline (self-contained), and tell the person the connector needs redeploying',
    'not-ready': 'the emulator was still starting: call the tool again',
  };
  async function call(d) {
    const p = d.params || {};
    log.calls++; changed();
    if (!tools.some((t) => t.name === p.name)) return send({ id: d.id, error: { code: -32602, message: `unknown tool: ${p.name}` } });
    const ctl = new AbortController();
    running.set(d.id, ctl);
    try {
      let timer;
      await Promise.race([ready, new Promise((r) => { timer = setTimeout(r, EARLY_WAIT_MS); })]);
      clearTimeout(timer);
      if (failed) return send({ id: d.id, result: refusal(failed.code, REMEDY[failed.code], failed.detail) });
      if (!impl) return send({ id: d.id, result: refusal('not-ready', REMEDY['not-ready'], `not ready after ${EARLY_WAIT_MS / 1000} s`) });
      const result = await impl.call(p.name, p.arguments || {}, { signal: ctl.signal });
      if (!ctl.signal.aborted) send({ id: d.id, result });
    } catch (err) {
      send({ id: d.id, result: refusal('tool-failed', 'the panel failed to run the tool (detail says why)', String((err && err.message) || err)) });
    } finally { running.delete(d.id); }
  }
  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== host || !d || d.jsonrpc !== '2.0') return;
    if (d.id !== undefined && !d.method) { const w = waiting.get(d.id); if (w) { waiting.delete(d.id); if (d.error) w.no(d.error); else w.ok(d.result); } return; }
    if (d.method === 'tools/list') { log.lists++; changed(); send({ id: d.id, result: { tools } }); return; }
    if (d.method === 'tools/call') { call(d); return; }
    if (d.method === 'ping') { send({ id: d.id, result: {} }); return; }
    if (d.method === 'notifications/cancelled') { const c = d.params && running.get(d.params.requestId); if (c) c.abort(); return; }
    if (d.method) { log.other.push(d.method.replace(/^ui\/notifications\//, '')); if (log.other.length > 6) log.other.shift(); changed(); }
    if (d.id !== undefined) send({ id: d.id, error: { code: -32601, message: `method not supported: ${d.method}` } });
  });
  log.initSent = ms();
  log.initSentAt = performance.now();   // (the browser check compares it with the emulator module's start)
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'cloadm', version: String(cfg.version || '') },
    appCapabilities: { tools: { listChanged: true }, availableDisplayModes: ['inline', 'fullscreen'] } })
    .then((r) => {
      log.init = ms(); B.host = r;
      send({ method: 'ui/notifications/initialized', params: {} });
      log.initialized = ms();
      if (impl) listChanged();
      changed();
    }, (er) => { log.init = `failed: ${(er && er.message) || er}`; changed(); });
})();
