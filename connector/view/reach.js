// Whether the small view (Open CLOADM) can reach the site its emulator comes from: a CLASSIC script, inlined by
// connector/build.js into that view only, after the bridge (./bridge.js) and before the module that imports panel.js.
// It has to live in the view's own HTML: when the host blocks the site, panel.js never arrives to say so.
// A load is blocked when any of these is seen before panel.js has loaded:
//  * the host's ui/initialize answer has hostCapabilities.sandbox.csp, and its resourceDomains do not hold ORIGIN in
//    any spelling (with or without scheme or trailing slash): the host says it will not let the view load code from
//    there. This block is soft: should panel.js load after all, it is taken back;
//  * a securitypolicyviolation for a URL on ORIGIN;
//  * the import of panel.js fails (CLOADM_REACH.importFailed, called by the view's module);
//  * nothing has loaded after WAIT_MS, unless the host's csp allows ORIGIN (then it is only slow). Soft too: a load that
//    arrives later still starts, and Claude is told on the same channel that the view loaded after all.
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
  // soft: only a sign so far (the host's csp, or slowness), so an emulator that loads after all still attaches and the
  // block is taken back; hard: the load really failed (a policy violation, a failed import), which a soft block gives
  // way to
  function block(why, { soft: weak = false } = {}) {
    if (loaded || (blocked && !(soft && !weak))) return;
    const first = !blocked;
    blocked = why; soft = weak;
    clearTimeout(timer);
    B.fail(why, { code: 'blocked', soft: weak });
    if (first) {
      const s = el('status');
      if (s) { s.className = 'error'; s.textContent = MESSAGE; }
      const a = el('announce');
      if (a) a.textContent = MESSAGE;
    }
    show();
    report();
  }
  // a domain as the host may write it: with or without the scheme, with or without a trailing slash, any case
  const norm = (d) => String(d).trim().toLowerCase().replace(/\/+$/, '');
  const HOST = norm(ORIGIN).replace(/^[a-z]+:\/\//, '');
  const allows = (csp) => !!csp && Array.isArray(csp.resourceDomains) && csp.resourceDomains.some((d) => norm(d) === norm(ORIGIN) || norm(d) === HOST);
  const sandboxCsp = () => (B.host && B.host.hostCapabilities && B.host.hostCapabilities.sandbox && B.host.hostCapabilities.sandbox.csp) || null;
  B.onChange(() => {
    const csp = sandboxCsp();
    if (csp && !loaded && !blocked && !allows(csp)) block(`the host does not allow ${ORIGIN} (sandbox csp resourceDomains ${JSON.stringify(csp.resourceDomains ?? null)})`, { soft: true });
    report();
  });
  if (doc) doc.addEventListener('securitypolicyviolation', (e) => { if (String(e.blockedURI || '').startsWith(ORIGIN)) block(`the host's policy blocked ${e.blockedURI} (${e.effectiveDirective || e.violatedDirective})`); });
  // slow, not blocked, when the host has said it allows the site: then only a failed import or a violation counts
  timer = setTimeout(() => { if (!allows(sandboxCsp())) block(`nothing loaded from ${ORIGIN} within ${WAIT_MS / 1000} s`, { soft: true }); }, WAIT_MS);
  // panel.js arrived after a soft block: take it back, where Claude was told
  function recover() {
    blocked = null; soft = false;
    const s = el('status');
    if (s && s.textContent === MESSAGE) { s.className = ''; s.textContent = 'Starting CLOADM…'; }
    const content = [{ type: 'text', text: 'CLOADM\'s panel loaded after all (it was only slow): keep using this view; the offline copy is not needed.' }];
    if (reported === 'message') send('ui/message', { role: 'user', content });
    else if (reported === 'model context') send('ui/update-model-context', { content });
    if (reported) reported += ', then taken back';
  }
  window.CLOADM_REACH = {
    MESSAGE,
    get blocked() { return blocked; },
    get reported() { return reported; },
    // panel.js arrived: nothing more to watch (an arrival after a soft block still starts, and the block is taken back)
    loaded() { loaded = true; clearTimeout(timer); if (blocked && soft) recover(); },
    importFailed(e) { block(`the import of panel.js failed: ${(e && e.message) || e}`); },
  };
})();
