// SPIKE (claude/plugin-live-panel-spike, not for merging as-is): a live view of the LOCAL stdio server's machines.
// `node cli/cloadm.js --mcp --panel` adds, beside the machine tools:
//  * open_emulator, a tool with _meta.ui.resourceUri = ui://cloadm/live.html (MCP Apps, ext-apps specification
//    2026-01-26). The host renders that resource; it is a mirror, not an emulator: the machines stay in this server,
//    where the model's tools, the person's ROMs and the media root (~/CLOADM) already are;
//  * two app-only tools (_meta.ui.visibility ["app"]: the host offers them to the view, never to the model), which
//    the view calls through the host (tools/call, the spec's callServerTool):
//      view_frame { machine_id? }               runs the machine for the real time since the view's last call (at
//                                               most MIRROR_FRAMES_MAX frames) and returns its screen as a PNG;
//      view_keys  { machine_id?, text?, keys? } types text (type_text) or taps named keys (press_keys) on it;
//    with no machine_id they use the newest machine, booting a Dragon 64 when there is none;
//  * resources/list and resources/read for the view (MIME text/html;profile=mcp-app, no CSP: it fetches nothing).
// Why a mirror and not the connector's in-view emulator: Claude does not call the tools a view registers (app tools)
// when the view comes from a local server (claude.com/docs/connectors/building/mcp-apps/app-tools, "Views that Claude
// can reach"), so the model could not drive an emulator living in the view.
// Every call goes through the server's one queue (cli/mcp.js handles one message at a time), so the view and the
// model never run the machine at the same time.
'use strict';
const fs = require('fs');
const path = require('path');

const MIME = 'text/html;profile=mcp-app';
const VIEW_URI = 'ui://cloadm/live.html';
const EXTENSION = 'io.modelcontextprotocol/ui';
const MIRROR_FRAMES_MAX = 10;   // a slow poll does not make the machine catch up in one burst

const OPEN_TEXT = 'CLOADM\'s live view is opening: it shows the newest machine of this server (booting a Dragon 64 if none is on) and lets the person type on it. Drive that machine with this server\'s tools as usual (list_machines gives its machine_id); the view follows. While the view is open the machine also runs in real time between your calls.';
const OPEN = {
  name: 'open_emulator', title: 'Show the emulator in a live view',
  description: `Opens a live view of CLOADM's emulator (Dragon 32/64/200, Tandy Color Computer 1/2/3, MC-10) that the person can move to the side panel and type into. ${OPEN_TEXT}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Show the emulator in a live view', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: VIEW_URI } },
};
const appOnly = { ui: { resourceUri: VIEW_URI, visibility: ['app'] } };
const machineId = { type: 'string', description: 'the machine to show (default: the newest)' };
const VIEW_FRAME = {
  name: 'view_frame', title: 'Live view: the next frame', description: 'For the CLOADM live view only: runs the machine for the real time since the last call and returns its screen.',
  inputSchema: { type: 'object', properties: { machine_id: machineId }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
};
const VIEW_KEYS = {
  name: 'view_keys', title: 'Live view: keys the person typed', description: 'For the CLOADM live view only: the person\'s typing, on the machine shown.',
  inputSchema: { type: 'object', properties: { machine_id: machineId, text: { type: 'string', maxLength: 200 }, keys: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
};
const TOOLS = [OPEN, VIEW_FRAME, VIEW_KEYS];

// toolbox: the server's (js/mcp/tools.js createToolbox); now() -> ms; base64(bytes) -> text; html: the view's HTML
function createPanel({ toolbox, now = () => Date.now(), base64 = (b) => Buffer.from(b).toString('base64'), html = null }) {
  const last = new Map();   // machine_id -> the time of the view's last frame
  const refusal = (error) => ({ content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true });
  async function pick(id) {
    if (id != null) return id;
    const l = await toolbox.call('list_machines', {});
    const ms = l.ok ? l.data.machines : [];
    if (ms.length) return ms[ms.length - 1].machine_id;
    const b = await toolbox.call('boot', { model: 'dragon64' });
    if (!b.ok) throw b.error;
    return b.data.machine.machine_id;
  }
  async function frame(args, signal) {
    const id = await pick(args.machine_id);
    const t = now(), before = last.get(id);
    last.set(id, t);
    let ran = 0;
    if (before != null) {
      const n = Math.min(MIRROR_FRAMES_MAX, Math.floor((t - before) / 20));
      if (n > 0) { const r = await toolbox.call('run_frames', { machine_id: id, frames: n }, { signal }); if (!r.ok) return refusal(r.error); ran = r.data.frames_run; }
    }
    const s = await toolbox.call('screenshot', { machine_id: id, scale: 1 }, { signal });
    if (!s.ok) return refusal(s.error);
    const data = { machine_id: id, frames_run: ran };
    return { content: [{ type: 'text', text: JSON.stringify(data) }, { type: 'image', data: base64(await s.image), mimeType: 'image/png' }], structuredContent: data };
  }
  async function keys(args, signal) {
    const id = await pick(args.machine_id);
    const out = [];
    if (args.text) out.push(await toolbox.call('type_text', { machine_id: id, text: args.text }, { signal }));
    if (args.keys && args.keys.length) out.push(await toolbox.call('press_keys', { machine_id: id, keys: args.keys }, { signal }));
    const bad = out.find((r) => !r.ok);
    if (bad) return refusal(bad.error);
    return { content: [{ type: 'text', text: JSON.stringify({ machine_id: id }) }], structuredContent: { machine_id: id } };
  }
  return {
    extension: { [EXTENSION]: { mimeTypes: [MIME] } },
    tools: () => TOOLS,
    has: (name) => TOOLS.some((t) => t.name === name),
    async call(name, args = {}, { signal = null } = {}) {
      try {
        if (name === OPEN.name) return { content: [{ type: 'text', text: OPEN_TEXT }] };
        if (name === VIEW_FRAME.name) return await frame(args || {}, signal);
        return await keys(args || {}, signal);
      } catch (e) {
        return refusal(e && e.code ? e : { code: 'tool-failed', remedy: 'reopen the view', detail: String((e && e.message) || e) });
      }
    },
    resources: () => [{ uri: VIEW_URI, name: 'CLOADM (live view)', mimeType: MIME }],
    read(uri) {
      if (uri !== VIEW_URI) return null;
      const text = html || fs.readFileSync(path.join(__dirname, 'panel-view.html'), 'utf8');
      return { contents: [{ uri, mimeType: MIME, text, _meta: { ui: { prefersBorder: false } } }] };
    },
  };
}

module.exports = { createPanel, MIME, VIEW_URI, EXTENSION, MIRROR_FRAMES_MAX };
