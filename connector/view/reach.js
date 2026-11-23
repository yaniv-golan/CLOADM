// Whether the small view (Open CLOADM) can reach the site its emulator comes from: a CLASSIC script, inlined by
// connector/build.js into that view only, after the bridge (./bridge.js) and before the module that imports panel.js.
// It has to live in the view's own HTML: when the host blocks the site, panel.js never arrives to say so.
// A load is blocked when any of these is seen before panel.js has loaded:
//  * the host's ui/initialize answer has hostCapabilities.sandbox.csp, and its resourceDomains do not hold ORIGIN
//    (the host has said it will not let the view load code from there);
//  * a securitypolicyviolation for a URL on ORIGIN;
//  * the import of panel.js fails (CLOADM_REACH.importFailed, called by the view's module);
//  * nothing has loaded after WAIT_MS (a slow load that arrives later still starts: the bridge takes it).
// Then the status line says so, the bridge answers every call with "blocked" (its remedy names the offline copy), and
// the host is told where Claude reads it: ui/message when the host offers it (hostCapabilities.message), else
// ui/update-model-context when it offers that. Details shows which (reported: ...).
// ORIGIN is the build's: connector/build.js writes it in where the placeholder is.
(() => {
  const ORIGIN = __ORIGIN__;
  const WAIT_MS = 8000;
  const MESSAGE = 'This app can\'t reach cloadm.dev here. Ask Claude to open the offline copy.';
  const B = window.CLOADM_BRIDGE;
  let loaded = false, blocked = null, soft = false, reported = null, timer = null;
  const doc = typeof document === 'undefined' ? null : document;
  const el = (id) => (doc ? doc.getElementById(id) : null);
  let rid = 0;
  const send = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', id: `reach-${++rid}`, method, params }, '*');
  // once the handshake is done: the first channel the host offers
  function report() {
    if (!blocked || reported || !B.host) return;
    const caps = B.host.hostCapabilities || {};
    const text = `CLOADM's panel could not load its code from cloadm.dev in this app (${blocked}). Open the offline copy instead (open_emulator_inline): it needs nothing from cloadm.dev. No need to ask the person first.`;
    const content = [{ type: 'text', text }];
    if (caps.message) { send('ui/message', { role: 'user', content }); reported = 'message'; }
    else if (caps.updateModelContext) { send('ui/update-model-context', { content }); reported = 'model context'; }
    else reported = 'tool results only';
    show();
  }
  function show() {
    const st = el('st');
    if (st && blocked) st.textContent = `blocked: ${blocked} · reported: ${reported || 'waiting for the handshake'} · ${B.describe()}`;
  }
  function block(why, { late = false } = {}) {
    if (loaded || blocked) return;
    blocked = why; soft = late;
    clearTimeout(timer);
    B.fail(why, { code: 'blocked', soft: late });
    const s = el('status');
    if (s) { s.className = 'error'; s.textContent = MESSAGE; }
    const a = el('announce');
    if (a) a.textContent = MESSAGE;
    show();
    report();
  }
  const allows = (csp) => !!csp && Array.isArray(csp.resourceDomains) && csp.resourceDomains.includes(ORIGIN);
  B.onChange(() => {
    if (B.host && !loaded && !blocked) {
      const sb = B.host.hostCapabilities && B.host.hostCapabilities.sandbox;
      if (sb && sb.csp && !allows(sb.csp)) block(`the host does not allow ${ORIGIN} (sandbox csp resourceDomains ${JSON.stringify(sb.csp.resourceDomains ?? null)})`);
    }
    report();
  });
  if (doc) doc.addEventListener('securitypolicyviolation', (e) => { if (String(e.blockedURI || '').startsWith(ORIGIN)) block(`the host's policy blocked ${e.blockedURI} (${e.effectiveDirective || e.violatedDirective})`); });
  timer = setTimeout(() => block(`nothing loaded from ${ORIGIN} within ${WAIT_MS / 1000} s`, { late: true }), WAIT_MS);
  window.CLOADM_REACH = {
    MESSAGE,
    get blocked() { return blocked; },
    get reported() { return reported; },
    // panel.js arrived: nothing more to watch (a late arrival after the timeout still starts)
    loaded() { loaded = true; clearTimeout(timer); if (soft) blocked = null; },
    importFailed(e) { block(`the import of panel.js failed: ${(e && e.message) || e}`); },
  };
})();
