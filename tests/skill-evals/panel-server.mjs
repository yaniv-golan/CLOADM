#!/usr/bin/env node
// A stand-in for the side panel, for the skill's panel-route evals (a case whose prompt.md says `server: panel`):
// a stdio MCP server that answers as the connector would once its view has loaded. Its instructions are the Worker's
// (connector/build.js essentials(), the skill's "connector essentials" section, opening "You are driving CLOADM in the
// person's side panel."), and its tools are the panel's own (connector/view/tools.js panelToolbox on a Session, as
// connector/view/panel.js makes it: a Dragon 64 without ROMs running LIZA), plus open_emulator. What it cannot be is
// the browser: there is no view, so open_emulator only says the emulator is open, and the panel's tools are listed
// from the start rather than in the next message. Only the project's own programs; no ROMs.
//   node tests/skill-evals/panel-server.mjs [--stopped]     (run.js starts it; it reads JSON-RPC lines on stdin)
// --stopped (a case's `panel_state: stopped`): LIZA is at her prompt and the person has stopped the machine in the
// panel's Debugger, so the tools that must run it refuse with machine-stopped until it is resumed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { essentials } from '../../connector/build.js';
import { panelToolbox } from '../../connector/view/tools.js';
import { Session } from '../../js/session.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { framePng } = createRequire(import.meta.url)(path.join(ROOT, 'cli', 'cloadm.js'));
const program = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));

const session = new Session({ welcomeMenu: false });
session.switchMachine('dragon64', undefined, { menu: false });
await session.startLiza(program);
if (process.argv.includes('--stopped')) { session.runFrames(150); session.debug.halt(); }
const toolbox = panelToolbox(session, { png: framePng, program, now: () => Date.now(), date: () => new Date(), yield: () => new Promise((r) => setImmediate(r)) });
const OPEN = { name: 'open_emulator', title: 'Open CLOADM', description: 'Opens the CLOADM emulator in a panel beside the chat. Use this first. (Here: the machine on screen is machine_id "m1", already on (no boot needed), running LIZA.)',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } };

const send = (m) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
const b64 = (b) => Buffer.from(b).toString('base64');
for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
  if (msg.id == null) continue;   // notifications
  const p = msg.params || {};
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: p.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'CLOADM side panel', version: '0' }, instructions: essentials() } });
  else if (msg.method === 'ping') send({ id: msg.id, result: {} });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [OPEN, ...toolbox.tools()] } });
  else if (msg.method === 'tools/call' && p.name === 'open_emulator') send({ id: msg.id, result: { content: [{ type: 'text', text: 'CLOADM is open in the side panel: machine_id "m1", a Dragon 64 running LIZA. Its tools are available now.' }] } });
  else if (msg.method === 'tools/call') send({ id: msg.id, result: await toolbox.call(p.name, p.arguments || {}, { base64: b64 }) });
  else send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}
