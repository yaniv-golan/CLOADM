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
import { profiles } from '../../js/machines/profiles.js';
import { GAMES } from '../../js/session.js';
import { panelToolbox, PANEL_API, PROGRAM_FILES } from './tools.js';
import { menu, menuItem, fitScreen, claudeAction, activity } from './ui.js';

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

// the Programs menu: the built-in programs, which need no ROMs (BASIC is offered when the model's ROMs are stored)
const PROGRAMS = [['welcome', 'Welcome menu'], ['liza', 'LIZA'], ['2048', GAMES.list[2048].name], ['minesweeper', GAMES.list.minesweeper.name]];
const PROGRAM_NAMES = Object.assign(Object.fromEntries(PROGRAMS), { welcome: 'The Welcome menu', demo: 'The colour demo', basic: 'BASIC' });
// the sound switch's icons (drawn, not emoji: the same in every browser and font)
const SPEAKER = '<path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor"/>';
const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
// the Machine menu's groups, by keyboard
const GROUPS = [['Dragon', (p) => p.keyboard.startsWith('dragon')], ['Color Computer', (p) => p.keyboard === 'coco'], ['MC-10', (p) => !p.keyboard.startsWith('dragon') && p.keyboard !== 'coco']];

export async function start() {
  const cfg = globalThis.CLOADM_VIEW || {};
  const bridge = globalThis.CLOADM_BRIDGE;
  const facts = { variant: cfg.variant || '?', host: '…', mode: '…', csp: '…', storage: '…', audio: 'off until a click' };
  const show = () => { $('st').textContent = `${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(' · ')} · ${bridge.describe()}`; };
  // the raw message (a load's, the ROMs'), for Details; the person sees the friendly status
  const say = (t) => { $('msg').textContent = t; };
  // the status line: text, and an action button after it ({ label, run }) or none
  const status = (text, action = null) => {
    const el = $('status');
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = action.run;
      el.append(b);
    }
  };
  const hostFacts = () => {
    const r = bridge.host;
    if (!r) return;
    facts.host = (r.hostInfo && r.hostInfo.name) || '?';
    const c = r.hostCapabilities && r.hostCapabilities.sandbox && r.hostCapabilities.sandbox.csp;
    facts.csp = `resourceDomains ${JSON.stringify(c ? c.resourceDomains ?? null : null)}, connectDomains ${JSON.stringify(c ? c.connectDomains ?? null : null)}`;
  };
  let fit = () => {};
  // the side-panel button only where the view is not already there (the host's displayMode), and the host offers it
  const syncMode = () => {
    const c = bridge.hostContext || {}, mode = c.displayMode || 'inline';
    facts.mode = mode;
    $('big').hidden = mode === 'fullscreen' || (Array.isArray(c.availableDisplayModes) && !c.availableDisplayModes.includes('fullscreen'));
    fit();
  };
  bridge.onChange(() => { hostFacts(); syncMode(); show(); });
  syncMode();
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
  const model = (id) => (profiles[id] ? profiles[id].name : String(id));

  // what runs, for the status line: a program's name (PROGRAM_NAMES) or null (the built-in firmware's prompt), and
  // whether Claude started it
  const now = { program: null, byClaude: false };
  let claudeBusy = false;
  const describe = () => {
    const m = session.machine, name = m.profile.name;
    if (now.program) return status(`${now.program} is running on the ${name}${now.byClaude ? ' (Claude started it)' : ''}.`);
    if (m.hasRom) return status(`BASIC is running on the ${name}, with your ROMs.`);
    status(`The ${name} is on its built-in firmware: pick a program, or add ROMs for BASIC.`, { label: 'Add ROMs…', run: () => $('rom').click() });
  };
  const running = (program) => { now.program = program; now.byClaude = claudeBusy; describe(); };
  // a SessionError (a game on a machine that cannot run it) -> the status line
  const attempt = (fn) => { try { fn(); } catch (e) { status(e.message); } };

  const runLiza = () => {
    if (session.machine.hasRom) session.runWithoutRoms({ menu: false });
    say(session.runLiza(files[session.lizaFile]));
    running('LIZA');
  };
  const runProgram = (name) => attempt(() => {
    if (name === 'liza') return runLiza();
    if (name === 'welcome') { say(session.startWelcome(files[session.welcomeFile])); return running(PROGRAM_NAMES.welcome); }
    if (name === 'basic') { session.useStoredRoms(session.machine); session.powerCycle({ menu: false }); return running(null); }
    if (name === 'demo') { say(session.load('demo.bin', files['demo.bin'], { remember: false })); return running(PROGRAM_NAMES.demo); }
    session.checkGame(name);
    say(session.runGame(name, files[session.gameFile(name)]));
    running(PROGRAM_NAMES[name]);
  });
  // the Welcome menu's choices (its keys emit them, after the frame): as on the page, minus what the panel lacks
  const welcomeChoice = (choice) => {
    if (['liza', 'demo', '2048', 'minesweeper'].includes(choice)) runProgram(choice);
    else if (choice === 'roms') status('ROMs are added from the toolbar: Add ROMs….', { label: 'Add ROMs…', run: () => $('rom').click() });
    else if (choice === 'claude') status('You are with Claude already: ask in the chat.');
  };
  session.on((ev) => {
    if (ev === 'machine') { input.setMachine(session.machine); now.program = null; describe(); }
    if (['machine', 'firmware', 'reset', 'loaded'].includes(ev)) audio.discontinuity();
    if (typeof ev === 'string' && ev.startsWith('welcome:')) { const choice = ev.slice(8); setTimeout(() => welcomeChoice(choice)); }
  });
  session.switchMachine('dragon64', undefined, { menu: false });
  if (session.machine.hasRom) say('Your ROMs are stored in this panel: BASIC starts. LIZA is one click away.');
  else runLiza();
  describe();

  // the tools: while one runs it drives the machine's frames itself, so the page's own frame loop only draws
  const toolbox = panelToolbox(session, {
    png,
    program: (f) => { if (!files[f]) throw new McpToolError('cannot-read', `${f} is not a bundled program`); return files[f]; },
    now: () => performance.now(),
    date: () => new Date(),
    yield: nextTask,
  });
  // Claude's calls that change the machine show the cue on the screen; the person's own keys and clicks never do
  const cue = activity($('activity'), $('activity-what'), $('activity-keys'));
  let busy = false, queue = Promise.resolve();
  const call = (name, args, { signal } = {}) => {
    const run = queue.then(async () => {
      busy = true;
      const action = claudeAction(name, args || {}, { model, program: (id) => PROGRAM_NAMES[id] || id });
      if (action) cue.show(action);
      claudeBusy = true;
      try {
        const r = await toolbox.call(name, args, { signal, base64: toBase64 });
        if (!r.isError && name === 'load') running(args.program ? PROGRAM_NAMES[args.program] || args.program : String(args.path || '').split('/').pop());
        else if (!r.isError && name === 'assemble_and_load') running('Claude\'s program');
        return r;
      } finally {
        claudeBusy = false; busy = false; audio.discontinuity();
        if (action) cue.done();
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  let last = performance.now(), lines = 240;
  function tick(t) {
    requestAnimationFrame(tick);
    const m = session.machine;
    if (!busy) session.advance(t - last, { onFrame: () => audio.pushFrame(m.audioEvents, m.frameCycles, m.fps), now: () => performance.now() });
    last = t;
    const frame = m.render();
    if (frame.height !== lines) { lines = frame.height; fit(); }
    presenter.present(frame, session.display, canvas.width, canvas.height);
  }
  // the toolbar and the status line (with Details closed: open, it scrolls) stay in view with the screen
  const foot = () => Math.max($('status').offsetHeight, $('details').firstElementChild.offsetHeight) + 10;
  fit = fitScreen($('stage'), $('bezel'), canvas, { lines: () => lines, reserve: () => $('bar').offsetHeight + foot() });
  requestAnimationFrame(tick);

  // sound: off until a click (browsers allow it only after one); the button shows which, and turns it on or off
  const syncSound = () => {
    const b = $('sound'), on = !!audio.ctx && audio.enabled;
    b.innerHTML = on ? SPEAKER_ON : SPEAKER_OFF;
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Sound on: click to turn it off' : audio.ctx ? 'Sound off: click to turn it on' : 'Sound is off until you click: click to turn it on';
    facts.audio = !audio.ctx ? 'off until a click' : `${on ? 'on' : 'muted'}, ${audio.path}${audio.fallback ? ` (${audio.fallback})` : ''}`;
    show();
  };
  const unlock = () => { const first = !audio.ctx; audio.start(); if (first) { session.welcomeSound(); setTimeout(syncSound, 3500); } syncSound(); };
  syncSound();
  $('sound').onclick = () => {
    if (audio.ctx && audio.enabled) audio.enabled = false;
    else { audio.enabled = true; unlock(); }
    syncSound();
  };

  canvas.addEventListener('keydown', (e) => { unlock(); if (input.keydown(e)) e.preventDefault(); });
  canvas.addEventListener('keyup', (e) => input.keyup(e));
  canvas.addEventListener('blur', () => input.releaseAll());
  canvas.addEventListener('pointerdown', () => { canvas.focus(); unlock(); });

  // the menus
  const programsMenu = $('programs-menu');
  const fillPrograms = () => {
    const m = session.machine, list = PROGRAMS.slice();
    if (session.storedRomsWaiting(m)) list.push(['basic', 'BASIC (your ROMs)']);
    programsMenu.replaceChildren(...list.map(([id, label]) => {
      let why = null;
      if (GAMES.list[id]) try { session.checkGame(id); } catch (e) { why = e.message; }
      const item = menuItem(label, { tag: why ? 'not on this model' : null, attrs: { 'data-program': id } });
      if (why) { item.setAttribute('aria-disabled', 'true'); item.title = why; }
      return item;
    }));
  };
  menu($('programs'), programsMenu, {
    onOpen: fillPrograms,
    onPick: (item) => {
      if (item.getAttribute('aria-disabled') === 'true') { status(item.title); return; }
      runProgram(item.dataset.program);
      canvas.focus();
    },
  });
  const machineMenu = $('machine-menu');
  const fillMachines = () => {
    const cur = session.machine.id, out = [];
    for (const [group, has] of GROUPS) {
      const ids = Object.keys(profiles).filter((id) => has(profiles[id]));
      if (!ids.length) continue;
      const g = document.createElement('div');
      g.className = 'group'; g.setAttribute('role', 'presentation'); g.textContent = group;
      out.push(g);
      for (const id of ids) {
        const basic = session.machineRoms(id).bootable;
        out.push(menuItem(profiles[id].name, { role: 'menuitemradio', tag: basic ? 'BASIC' : 'no ROMs', tagOk: basic, attrs: { 'data-model': id, 'aria-checked': String(id === cur),
          title: basic ? 'Boots BASIC with your ROMs' : 'Runs the built-in programs; add its ROMs for BASIC' } }));
      }
    }
    const sep = document.createElement('div');
    sep.setAttribute('role', 'separator');
    out.push(sep, menuItem('Add ROMs for BASIC…', { attrs: { 'data-action': 'roms' } }));
    machineMenu.replaceChildren(...out);
  };
  menu($('machine'), machineMenu, {
    onOpen: fillMachines,
    onPick: (item) => {
      if (item.dataset.action === 'roms') { $('rom').click(); return; }
      const id = item.dataset.model;
      if (id !== session.machine.id) {
        session.switchMachine(id, undefined, { menu: false });
        if (!session.machine.hasRom) runProgram('welcome');
      }
      canvas.focus();
    },
  });
  menu($('more'), $('more-menu'), { onPick: () => { session.reset(); canvas.focus(); } });
  $('big').onclick = () => bridge.requestDisplayMode('fullscreen').then((r) => say(`mode: ${r.mode}`), (er) => say(`refused: ${er.message || er}`));
  $('roms').onclick = () => $('rom').click();
  // ROMs, optional: a file input or a drop. They stay in this panel's own storage (partitioned under the chat's
  // site) and are read only by the emulator: no tool takes or returns them
  async function addRoms(list) {
    const got = await Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    try {
      const r = session.addRoms(got);
      say(r.files.map((f) => `${f.name}: ${f.result}`).join('; ') + (session.machine.hasRom ? ' — BASIC starts.' : ''));
      if (session.machine.hasRom) { now.program = null; describe(); } else status('Those files are not ROMs this model takes. Details says what each one is.');
    } catch (e) { status(`ROMs: ${e.message}`); }
  }
  $('rom').onchange = (e) => addRoms(e.target.files);
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addRoms(e.dataTransfer.files); });
  for (const id of ['programs', 'machine', 'sound', 'roms', 'more']) $(id).disabled = false;

  hostFacts();
  syncMode();
  bridge.attach({ api: PANEL_API, tools: toolbox.tools(), call });
  facts.storage = `${await probeStorage()}; media store ${mediaNote}`;
  show();
  window.cloadmView = { session, toolbox, facts, loadedAt, audio, cue };   // for the browser check
}
