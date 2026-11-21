// CLOADM inside the side-panel view (MCP Apps, no iframe): the emulator, its screen and keyboard, ROMs the person
// adds in the panel, and the app tools (./tools.js) served through the bridge (./bridge.js), which shook hands with
// the host before this module even started.
// Shipped two ways by connector/build.js:
//   A (open_emulator):        the view imports this file from https://cloadm.dev/connector/view/panel.js, and it
//                             imports js/ beside it, so the glue and the emulator always come from the same release
//                             of the site; the bridge checks PANEL_API against the one the Worker was built with;
//   B (open_emulator_inline): this file and its whole import graph folded into the view (connector/fold.js).
// globalThis.CLOADM_VIEW, set by the view's first script: { variant, api, version, tools, programs? } (programs: base64
// of the bundled programs' files in B; A fetches them from the site, beside js/). No ROM is involved anywhere.
import { Session } from '../../js/session.js';
import { CanvasPresenter } from '../../js/video/canvas.js';
import { frameToRGBA } from '../../js/video/frame.js';
import { HostInput } from '../../js/host/input.js';
import { localStore } from '../../js/host/storage.js';
import { openMediaStore } from '../../js/host/media-store-open.js';
import { MemoryMediaStore } from '../../js/host/media-store-memory.js';
import { Audio } from '../../js/host/audio.js';
import { McpToolError } from '../../js/mcp/tools.js';
import { panelToolbox, PANEL_API, PROGRAM_FILES } from './tools.js';

export { PANEL_API };
const loadedAt = performance.now();   // this module's code began (all of its imports loaded): the browser check compares the handshake with it

const $ = (id) => document.getElementById(id);
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// a Frame as PNG bytes, each pixel repeated `scale` times across and down
async function png(frame, scale) {
  const px = frameToRGBA(frame);
  const src = new OffscreenCanvas(frame.width, frame.height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), frame.width, frame.height), 0, 0);
  const out = new OffscreenCanvas(frame.width * scale, frame.height * scale), g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, out.width, out.height);
  return new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
// between frames of a long tool call: a task of its own, so the host's messages and the screen get their turn
const channel = new MessageChannel(), yields = [];
channel.port1.onmessage = () => { const r = yields.shift(); if (r) r(); };
const nextTask = () => new Promise((r) => { yields.push(r); channel.port2.postMessage(0); });

async function programs(cfg) {
  if (cfg.programs) return Object.fromEntries(Object.entries(cfg.programs).map(([f, b]) => [f, fromBase64(b)]));
  const got = await Promise.all(PROGRAM_FILES.map(async (f) => {
    const r = await fetch(new URL(`../../examples/${f}`, import.meta.url));
    if (!r.ok) throw new Error(`examples/${f}: HTTP ${r.status}`);
    return [f, new Uint8Array(await r.arrayBuffer())];
  }));
  return Object.fromEntries(got);
}

async function probeStorage() {
  const out = [];
  try { localStorage.setItem('cloadm.probe', '1'); out.push(`localStorage ${localStorage.getItem('cloadm.probe') === '1' ? 'ok' : 'no'}`); } catch (e) { out.push(`localStorage no (${e.name})`); }
  try {
    await new Promise((ok, no) => {
      const r = indexedDB.open('cloadm-probe', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('p');
      r.onsuccess = () => { const db = r.result, t = db.transaction('p', 'readwrite'); t.objectStore('p').put(1, 'k'); t.oncomplete = () => { db.close(); ok(); }; t.onerror = () => no(t.error); };
      r.onerror = () => no(r.error);
    });
    out.push('IndexedDB ok');
  } catch (e) { out.push(`IndexedDB no (${e && e.name})`); }
  try { await navigator.storage.getDirectory(); out.push('OPFS ok'); } catch (e) { out.push(`OPFS no (${e && e.name})`); }
  return out.join(', ');
}

export async function start() {
  const cfg = globalThis.CLOADM_VIEW || {};
  const bridge = globalThis.CLOADM_BRIDGE;
  const facts = { variant: cfg.variant || '?', host: '…', csp: '…', storage: '…', audio: 'off until a click' };
  const show = () => { $('st').textContent = `${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(' · ')} · ${bridge.describe()}`; };
  const say = (t) => { $('msg').textContent = t; };
  const hostFacts = () => {
    const r = bridge.host;
    if (!r) return;
    facts.host = (r.hostInfo && r.hostInfo.name) || '?';
    const c = r.hostCapabilities && r.hostCapabilities.sandbox && r.hostCapabilities.sandbox.csp;
    facts.csp = `resourceDomains ${JSON.stringify(c ? c.resourceDomains ?? null : null)}, connectDomains ${JSON.stringify(c ? c.connectDomains ?? null : null)}`;
  };
  bridge.onChange(() => { hostFacts(); show(); });
  show();

  const files = await programs(cfg);
  let media, mediaNote;
  try { media = await openMediaStore(); mediaNote = media.constructor.name; } catch (e) { media = new MemoryMediaStore(); mediaNote = `memory (${e.message})`; }
  const session = new Session({ store: localStore(), media, welcomeMenu: false });
  try { await session.ready(); } catch (e) { session.useMediaStore(new MemoryMediaStore()); mediaNote = `memory (${e.message})`; }
  const canvas = $('screen');
  const presenter = new CanvasPresenter(canvas);
  const input = new HostInput(session.machine, session.keys);
  const audio = new Audio();
  session.on((ev) => {
    if (ev === 'machine') input.setMachine(session.machine);
    if (['machine', 'firmware', 'reset', 'loaded'].includes(ev)) audio.discontinuity();
  });
  session.switchMachine('dragon64', undefined, { menu: false });
  const runLiza = () => {
    if (session.machine.hasRom) session.runWithoutRoms({ menu: false });
    say(session.runLiza(files[session.lizaFile]));
  };
  if (session.machine.hasRom) say('Your ROMs are stored in this panel: BASIC starts. LIZA is one click away.');
  else runLiza();

  // the tools: while one runs it drives the machine's frames itself, so the page's own frame loop only draws
  const toolbox = panelToolbox(session, {
    png,
    program: (f) => { if (!files[f]) throw new McpToolError('cannot-read', `${f} is not a bundled program`); return files[f]; },
    now: () => performance.now(),
    date: () => new Date(),
    yield: nextTask,
  });
  let busy = false, queue = Promise.resolve();
  const call = (name, args, { signal } = {}) => {
    const run = queue.then(async () => {
      busy = true;
      try { return await toolbox.call(name, args, { signal, base64: toBase64 }); } finally { busy = false; audio.discontinuity(); }
    });
    queue = run.catch(() => {});
    return run;
  };

  let last = performance.now();
  function tick(now) {
    requestAnimationFrame(tick);
    const m = session.machine;
    if (!busy) session.advance(now - last, { onFrame: () => audio.pushFrame(m.audioEvents, m.frameCycles, m.fps), now: () => performance.now() });
    last = now;
    presenter.present(m.render(), session.display, canvas.width, canvas.height);
  }
  requestAnimationFrame(tick);

  canvas.addEventListener('keydown', (e) => { audio.start(); if (input.keydown(e)) e.preventDefault(); });
  canvas.addEventListener('keyup', (e) => input.keyup(e));
  canvas.addEventListener('blur', () => input.releaseAll());
  canvas.addEventListener('pointerdown', () => { canvas.focus(); audio.start(); setTimeout(() => { facts.audio = audio.path + (audio.fallback ? ` (${audio.fallback})` : ''); show(); }, 3500); });
  $('liza').onclick = () => { runLiza(); canvas.focus(); };
  $('reset').onclick = () => { session.reset(); canvas.focus(); };
  $('big').onclick = () => bridge.requestDisplayMode('fullscreen').then((r) => say(`mode: ${r.mode}`), (er) => say(`refused: ${er.message || er}`));
  // ROMs, optional: a file input or a drop. They stay in this panel's own storage (partitioned under the chat's
  // site) and are read only by the emulator: no tool takes or returns them
  async function addRoms(list) {
    const got = await Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    try {
      const r = session.addRoms(got);
      say(r.files.map((f) => `${f.name}: ${f.result}`).join('; ') + (session.machine.hasRom ? ' — BASIC starts.' : ''));
    } catch (e) { say(`ROMs: ${e.message}`); }
  }
  $('rom').onchange = (e) => addRoms(e.target.files);
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addRoms(e.dataTransfer.files); });

  hostFacts();
  bridge.attach({ api: PANEL_API, tools: toolbox.tools(), call });
  facts.storage = `${await probeStorage()}; media store ${mediaNote}`;
  show();
  window.cloadmView = { session, toolbox, facts, loadedAt };   // for the browser check
}
