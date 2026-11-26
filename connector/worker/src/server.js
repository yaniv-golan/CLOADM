// CLOADM's remote MCP connector, https://mcp.cloadm.dev/mcp: a Cloudflare Worker, no dependencies, no sign-in.
// Transport: Streamable HTTP, stateless: every POST /mcp carries one JSON-RPC message and gets one JSON reply (no
// sessions, no SSE stream, so GET is 405); a notification gets 202. Batches (a JSON array) are refused, as MCP
// 2025-06-18 removed them: one POST could otherwise ask for hundreds of copies of the 1 MiB view. A body is read up to
// BODY_MAX bytes and no further (a Content-Length over it is refused before reading). Nothing is stored and nothing is logged: the Worker keeps no state
// between requests, writes no console output, and wrangler.toml turns Workers Logs off.
// Server tools, minimal: each opens the emulator view (MCP Apps, _meta.ui.resourceUri); the emulator then runs in the
// person's browser, and its own tools (type_text, screen_text, run_frames, ...) are app tools the view registers
// (connector/view/). The two views (connector/build.js):
//   open_emulator         "Open CLOADM"                ui://cloadm/panel.html   CLOADM's code from https://cloadm.dev (csp:
//                                                                               that origin only); it tells a blocked load
//   open_emulator_inline  "Open CLOADM (offline copy)" ui://cloadm/inline.html  self-contained, nothing fetched (no csp)
// createServer(views) -> { fetch(request) }; ./index.js gives it the generated views.
export const MIME = 'text/html;profile=mcp-app';
export const ORIGIN = 'https://cloadm.dev';
// Origin (MCP Streamable HTTP, "Security": servers MUST validate it; a present, invalid Origin gets 403). Claude's clients
// call from servers (claude.ai's backend, Claude Code) and send none, so an absent Origin passes; a browser always sends
// one, and only Claude's own sites and this Worker's are let through (docs/deploy-connector.md, "Origin").
export const ALLOWED_ORIGINS = Object.freeze(['https://claude.ai', 'https://claude.com', 'https://mcp.cloadm.dev']);
export const BODY_MAX = 64 * 1024;   // the largest request read; a tools/call here has no arguments
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const NEXT = 'The machine on screen is machine_id "m1", already on (no boot needed): it boots LIZA, a small chatbot, or BASIC when the person has added their ROMs in the panel. Its tools (type_text, press_keys, screen_text, screenshot, run_frames, peek, find_bytes, disassemble, registers, step, run, assemble_and_load, load for the bundled programs welcome, liza, demo, 2048 and minesweeper, reset, power_cycle, boot and switch_machine) are offered by the view once it has loaded: use them in your next message, not in this one. The person approves each call. ROMs live in the panel; no tool reads or returns them, and the panel has no files or downloads.';
const BLOCKED = 'If the panel stays blank, or says it can\'t reach cloadm.dev, or its tools answer blocked, open the offline copy (open_emulator_inline) without asking.';
const TOOLS = [
  { name: 'open_emulator', title: 'Open CLOADM',
    description: 'Opens the CLOADM emulator in a panel beside the chat. Use this first.',
    uri: 'ui://cloadm/panel.html' },
  { name: 'open_emulator_inline', title: 'Open CLOADM (offline copy)',
    description: 'Only if Open CLOADM showed a blank or blocked panel: opens a larger copy that doesn\'t need to reach cloadm.dev.',
    uri: 'ui://cloadm/inline.html' },
].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: t.uri } } }));

// resourceDomains -> script-src, style-src, img-src, font-src, media-src; connectDomains -> connect-src (ext-apps
// specification/2026-01-26/apps.mdx, McpUiResourceCsp). Only the site the emulator's code comes from.
const resources = (views) => ({
  'ui://cloadm/panel.html': { name: 'CLOADM', text: views.site,
    meta: { ui: { csp: { resourceDomains: [ORIGIN], connectDomains: [ORIGIN] }, prefersBorder: false, preferredDisplayMode: 'fullscreen' } } },
  // no csp: the spec's restrictive default (script-src 'self' 'unsafe-inline') is all an inline module needs
  'ui://cloadm/inline.html': { name: 'CLOADM (offline copy)', text: views.inline,
    meta: { ui: { prefersBorder: false, preferredDisplayMode: 'fullscreen' } } },
});

// the request's body as text, or null once it passes `max` bytes (read no further)
async function readCapped(req, max) {
  if (!req.body) return '';
  const reader = req.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export function createServer(views) {
  // the MCP `instructions` are not written here: connector/build.js copies them from skills/cloadm/SKILL.md (the connector
  // essentials section) into the generated views, so the skill is their one source
  if (typeof views.instructions !== 'string' || !views.instructions) throw new Error('the views carry no instructions: build them with connector/build.js');
  const RES = resources(views);
  const info = { name: 'cloadm-panel', title: 'CLOADM side panel', version: views.version };
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  function handle(msg) {
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return ok(msg.id, { protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] } } },
          serverInfo: info, instructions: views.instructions });
      case 'ping': return ok(msg.id, {});
      case 'tools/list': return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const t = TOOLS.find((x) => x.name === p.name);
        if (!t) return err(msg.id, -32602, `unknown tool: ${p.name}`);
        return ok(msg.id, { content: [{ type: 'text', text: `CLOADM is opening in the view${t.name === 'open_emulator_inline' ? ' (the offline copy)' : ''}. ${NEXT}${t.name === 'open_emulator' ? ` ${BLOCKED}` : ''}` }] });
      }
      case 'resources/list': return ok(msg.id, { resources: Object.entries(RES).map(([uri, r]) => ({ uri, name: r.name, mimeType: MIME })) });
      case 'resources/read': {
        const r = RES[p.uri];
        if (!r) return err(msg.id, -32602, 'unknown resource');
        return ok(msg.id, { contents: [{ uri: p.uri, mimeType: MIME, text: r.text, _meta: r.meta }] });
      }
      default: return err(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/mcp') return new Response('CLOADM MCP connector: POST /mcp (https://cloadm.dev/docs/mcp.md)\n', { status: 404, headers: { 'content-type': 'text/plain' } });
      const origin = req.headers.get('origin');
      if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) return json({ jsonrpc: '2.0', error: { code: -32600, message: 'forbidden: this Origin may not use the connector' } }, 403);
      if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      const tooLarge = () => json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `request too large (at most ${BODY_MAX} bytes)` } }, 413);
      const declared = req.headers.get('content-length');
      if (declared !== null && !(Number(declared) <= BODY_MAX)) return tooLarge();
      const text = await readCapped(req, BODY_MAX);
      if (text === null) return tooLarge();
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
      if (Array.isArray(msg)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: batches are not supported (one JSON-RPC message per request)' } }, 400);
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 400);
      // a request gets its reply; a notification, or a reply to nothing we asked, gets none
      if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });
      return json(handle(msg));
    },
  };
}
