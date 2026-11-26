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
// The agent skill (skills/cloadm/) over the Skills extension, io.modelcontextprotocol/skills (js/mcp/skills.js), from
// the files connector/build.js copied into the views (views.skills): skills/list, skills/get, and resources/read and
// resources/list for its skill:// files beside the two views.
// Two protocol eras, as a dual-era server may (specification 2026-07-28, basic/versioning):
//  * the handshake revisions (VERSIONS, initialize): as before; the skills extension is declared in an initialize
//    result only to a client whose initialize declared it (those revisions define no skills), so a client that does not
//    ask sees the same handshake, tools and resources; being stateless, the Worker answers skills/list and skills/get to
//    any client that calls them;
//  * 2026-07-28 (MODERN_VERSIONS), stateless: a request whose params._meta names its protocol version. Its HTTP headers
//    are checked against the body (MCP-Protocol-Version, Mcp-Method, and Mcp-Name for tools/call and resources/read:
//    400 and HeaderMismatch -32020 when one is missing or differs), an unknown version is 400 with
//    UnsupportedProtocolVersionError -32022, an unknown method 404 with -32601; server/discover declares tools,
//    resources and both extensions (MCP Apps and skills); every result carries resultType and the server's identity in
//    _meta (basic/transports/streamable-http, server/discover).
// createServer(views) -> { fetch(request) }; ./index.js gives it the generated views.
import { createSkillServer, SKILLS_EXTENSION } from '../../../js/mcp/skills.js';
export const MIME = 'text/html;profile=mcp-app';
export const ORIGIN = 'https://cloadm.dev';
export const BODY_MAX = 64 * 1024;   // the largest request read; a tools/call here has no arguments
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const MODERN_VERSIONS = ['2026-07-28'];
const META = 'io.modelcontextprotocol/';
const LIST_TTL_MS = 3600000;   // the tools and views only change with a new deploy

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
  if (!Array.isArray(views.skills) || !views.skills.length) throw new Error('the views carry no skills: build them with connector/build.js');
  const RES = resources(views);
  const skills = createSkillServer(views.skills);
  const info = { name: 'cloadm-panel', title: 'CLOADM side panel', version: views.version };
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: Object.assign({ code, message }, data ? { data } : {}) });
  const capabilities = { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] } } };
  const withSkills = Object.assign({}, capabilities, { extensions: Object.assign({}, capabilities.extensions, { [SKILLS_EXTENSION]: skills.capability() }) });
  const cache = (modern) => (modern ? { ttlMs: LIST_TTL_MS, cacheScope: 'public' } : {});
  // -> [status, body]
  function handle(msg, modern) {
    const p = msg.params || {};
    const reply = (result) => [200, ok(msg.id, modern ? Object.assign({ resultType: 'complete' }, result, { _meta: Object.assign({}, result._meta, { [`${META}serverInfo`]: info }) }) : result)];
    const fail = (code, message) => [200, err(msg.id, code, message)];
    switch (msg.method) {
      case 'server/discover':
        if (!modern) break;
        return reply({ supportedVersions: [...MODERN_VERSIONS, ...VERSIONS], capabilities: withSkills, instructions: views.instructions, ...cache(true) });
      case 'initialize': {
        if (modern) break;
        const asks = !!(p.capabilities && p.capabilities.extensions && typeof p.capabilities.extensions === 'object' && p.capabilities.extensions[SKILLS_EXTENSION]);
        return reply({ protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
          capabilities: asks ? withSkills : capabilities, serverInfo: info, instructions: views.instructions });
      }
      case 'ping': if (modern) break; return reply({});
      case 'tools/list': return reply({ tools: TOOLS, ...cache(modern) });
      case 'tools/call': {
        const t = TOOLS.find((x) => x.name === p.name);
        if (!t) return fail(-32602, `unknown tool: ${p.name}`);
        return reply({ content: [{ type: 'text', text: `CLOADM is opening in the view${t.name === 'open_emulator_inline' ? ' (the offline copy)' : ''}. ${NEXT}${t.name === 'open_emulator' ? ` ${BLOCKED}` : ''}` }] });
      }
      // the skill files are listed to a 2026-07-28 client only: a stateless server cannot tell which handshake client
      // asked for skills, and the others keep the list they always had
      case 'resources/list': return reply({ resources: Object.entries(RES).map(([uri, r]) => ({ uri, name: r.name, mimeType: MIME })).concat(modern ? skills.resources() : []), ...cache(modern) });
      case 'resources/read': {
        const r = RES[p.uri];
        if (r) return reply({ contents: [{ uri: p.uri, mimeType: MIME, text: r.text, _meta: r.meta }], ...cache(modern) });
        const s = skills.read(p.uri);
        if (!s) return fail(-32602, 'unknown resource');
        return reply(s);
      }
      case 'skills/list': return reply(skills.list());
      case 'skills/get':
        try { return reply(skills.get(p)); } catch (e) { return fail(e.code, e.message); }
      default:
    }
    return modern ? [404, err(msg.id, -32601, `method not found: ${msg.method}`)] : fail(-32601, `method not found: ${msg.method}`);
  }
  // A 2026-07-28 request's headers against its body -> null, or the HeaderMismatch message (basic/transports/
  // streamable-http, "Server Validation"; a value may come Base64-encoded as =?base64?...?=)
  function headerMismatch(req, msg, version) {
    const decode = (v) => {
      const b = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
      if (!b) return v;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b[1]), (c) => c.charCodeAt(0))); } catch (e) { return null; }
    };
    const want = [['MCP-Protocol-Version', version], ['Mcp-Method', msg.method]];
    const p = msg.params || {};
    if (msg.method === 'tools/call' || msg.method === 'prompts/get') want.push(['Mcp-Name', p.name]);
    if (msg.method === 'resources/read') want.push(['Mcp-Name', p.uri]);
    for (const [name, body] of want) {
      const h = req.headers.get(name);
      if (h === null) return `Header mismatch: the ${name} header is missing`;
      if (decode(h) !== String(body)) return `Header mismatch: ${name} header value ${JSON.stringify(h)} does not match body value ${JSON.stringify(body)}`;
    }
    return null;
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/mcp') return new Response('CLOADM MCP connector: POST /mcp (https://cloadm.dev/docs/mcp.md)\n', { status: 404, headers: { 'content-type': 'text/plain' } });
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
      // a request that names its protocol version in _meta is a stateless (2026-07-28) one
      const meta = msg.params && typeof msg.params === 'object' && msg.params._meta;
      const modern = !!meta && typeof meta === 'object' && Object.hasOwn(meta, `${META}protocolVersion`);
      if (modern) {
        const version = meta[`${META}protocolVersion`];
        const mismatch = headerMismatch(req, msg, version);
        if (mismatch) return json(err(msg.id, -32020, mismatch), 400);
        if (!MODERN_VERSIONS.includes(version)) return json(err(msg.id, -32022, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...VERSIONS], requested: version }), 400);
      }
      const [status, body] = handle(msg, modern);
      return json(body, status);
    },
  };
}
