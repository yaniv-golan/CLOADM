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
import { Session, GAMES, PROGRAM_CONTROLS } from '../../js/session.js';
import { frameToRGBA } from '../../js/video/frame.js';
import { HostInput } from '../../js/host/input.js';
import { localStore } from '../../js/host/storage.js';
import { openMediaStore } from '../../js/host/media-store-open.js';
import { MemoryMediaStore } from '../../js/host/media-store-memory.js';
import { Audio } from '../../js/host/audio.js';
import { McpToolError } from '../../js/mcp/tools.js';
import { profiles } from '../../js/machines/profiles.js';
import { panelToolbox, PANEL_API, PROGRAM_FILES } from './tools.js';
import { menu, menuItem, fitScreen, CrispPresenter, describeCall, announcement, chip, insets, touchHost } from './ui.js';
import { touchPanel } from './touch.js';

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

// the programs that run without ROMs, by the name people know (Programs lists the ones this machine runs)
const PROGRAM_NAMES = { liza: 'LIZA', demo: 'The colour demo', 2048: GAMES.list[2048].name, minesweeper: GAMES.list.minesweeper.name, welcome: 'The Welcome menu' };
// the sound switch's icons (drawn, not emoji: the same in every browser and font)
const SPEAKER = '<path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor"/>';
const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
// the Machine menu's groups, by keyboard
const GROUPS = [['Dragon', (p) => p.keyboard.startsWith('dragon')], ['Color Computer', (p) => p.keyboard === 'coco'], ['MC-10', (p) => !p.keyboard.startsWith('dragon') && p.keyboard !== 'coco']];
const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
// characters still waiting in the machine's typist (a type_text call's keys not yet typed)
const pendingKeys = (m) => (m.typist ? m.typist.queue.filter((x) => typeof x === 'string' || (x && 'paced' in x)).length : 0);

export async function start() {
  const cfg = globalThis.CLOADM_VIEW || {};
  const bridge = globalThis.CLOADM_BRIDGE;
  const facts = { variant: cfg.variant || '?', host: '…', mode: '…', csp: '…', storage: '…', audio: 'off until a click' };
  const show = () => { $('st').textContent = `${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(' · ')} · ${bridge.describe()}`; };
  // the raw message (a load's, the ROMs'), for Details; the person sees the status line
  const say = (t) => { $('msg').textContent = t; };
  // the status line: one human line; an error the person must act on (announced, and kept whole)
  let statusTimer = null;
  const status = (text, { error = false, announce = false, brief = false } = {}) => {
    const el = $('status');
    clearTimeout(statusTimer);
    if (brief) statusTimer = setTimeout(() => describe(), 4000);   // a passing message ("Details copied."): then what runs again
    el.textContent = text;
    el.className = error ? 'error' : '';
    if (error || announce) $('announce').textContent = text;
  };
  const hostFacts = () => {
    const r = bridge.host;
    if (!r) return;
    facts.host = (r.hostInfo && r.hostInfo.name) || '?';
    const c = r.hostCapabilities && r.hostCapabilities.sandbox && r.hostCapabilities.sandbox.csp;
    facts.csp = `resourceDomains ${JSON.stringify(c ? c.resourceDomains ?? null : null)}, connectDomains ${JSON.stringify(c ? c.connectDomains ?? null : null)}`;
  };
  let fit = () => {}, describe = () => {}, keys = null;
  // a touch screen (the host says so, a coarse pointer, or a touch seen): the on-screen keys, and the insets a phone
  // app's own controls take in the side panel or fullscreen
  const coarse = matchMedia('(pointer: coarse)');
  let touchSeen = false;
  const touch = () => touchHost(bridge.hostContext || {}, { coarse: coarse.matches, seen: touchSeen });
  // the side-panel item only inline, where the host offers fullscreen (the side panel); the screen refits to the mode
  const syncMode = () => {
    const c = bridge.hostContext || {}, mode = c.displayMode || 'inline';
    facts.mode = `${mode}${c.containerDimensions ? ` ${JSON.stringify(c.containerDimensions)}` : ''}`;
    // the host's theme: Claude's colours stay the same in both; on a light host the bezel's Claude edge gets an outline
    document.documentElement.dataset.theme = c.theme === 'light' ? 'light' : 'dark';
    $('big').hidden = !(mode === 'inline' && Array.isArray(c.availableDisplayModes) && c.availableDisplayModes.includes('fullscreen'));
    const pad = insets(c, { touch: touch() }), root = document.documentElement.style;
    for (const [k, v] of [['--in-t', pad.top], ['--in-r', pad.right], ['--in-b', pad.bottom], ['--in-l', pad.left]]) if (root.getPropertyValue(k) !== v) root.setProperty(k, v);
    if (keys) keys.apply();
    fit();
  };
  // an emulator the bridge refused (another PANEL_API) or a start that failed: on the status line, not in Details
  const refused = () => {
    const f = bridge.failed;
    if (!f) return false;
    status(f.code === 'out-of-step' ? 'This connector and cloadm.dev are from different releases: ask Claude to open the emulator with open_emulator_inline, and the connector\'s owner to redeploy it.'
      : `CLOADM could not start: ${f.detail}. Ask Claude to open it again, or with open_emulator_inline.`, { error: true });
    return true;
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
  const presenter = new CrispPresenter(canvas, frameToRGBA);
  const input = new HostInput(session.shownMachine, session.keys);
  const audio = new Audio();
  const model = (id) => (profiles[id] ? profiles[id].name : String(id));
  const roms = (m = session.shownMachine) => (m.hasRom ? 'your ROMs' : session.machineRoms(m.id).bootable ? 'BASIC ready' : 'no ROMs');

  // the status line says what runs: a program's name, BASIC, or nothing yet (then what to do); Claude's last action
  // replaces it until something else happens
  const now = { program: null };
  describe = () => {
    const m = session.shownMachine, where = `${m.profile.name} · ${roms(m)}`;
    if (keys) keys.apply();   // (what runs may have changed: the keys' mode follows it)
    if (now.program) return status(`${now.program} is running · ${where}`);
    if (m.hasRom) return status(`BASIC is running · ${where}`);
    status(`${where} · Pick something from Programs, or ask Claude to play something.`);
  };
  const running = (program) => { now.program = program; describe(); };
  // the bundled program the Session runs now and what it is played with ({ id, input, extra, joystick }, as
  // Session.programControls gives it on the page, where the Welcome menu watches the program): this view's Session
  // has no menu to watch for, so it follows the Session's own 'program' event, whoever started the program (the
  // Programs menu, the Welcome menu's keys, Claude's load); a load, a reset, a firmware or machine change ends it.
  // The on-screen keys' mode follows it.
  let ran = null;
  session.on((ev, arg) => {
    if (ev === 'program') ran = arg;
    else if (['loaded', 'reset', 'welcome', 'firmware', 'machine'].includes(ev)) ran = null;
  });
  const programControls = () => {
    if (ran === 'liza') return { id: ran, ...PROGRAM_CONTROLS.liza };
    return ran && GAMES.list[ran] ? { id: ran, ...GAMES.list[ran].controls } : null;
  };
  // a SessionError (a game on a machine that cannot run it) -> the status line
  const attempt = (fn) => { try { fn(); } catch (e) { status(e.message, { announce: true }); } };

  const runLiza = () => {
    if (session.shownMachine.hasRom) session.runWithoutRoms({ menu: false });
    say(session.runLiza(files[session.lizaFile]));
    running('LIZA');
  };
  const runProgram = (name) => attempt(() => {
    if (name === 'liza') return runLiza();
    if (name === 'welcome') { say(session.startWelcome(files[session.welcomeFile])); return running(PROGRAM_NAMES.welcome); }
    if (name === 'demo') {
      if (session.shownMachine.hasRom) session.runWithoutRoms({ menu: false });
      say(session.load('demo.bin', files['demo.bin'], { remember: false }));
      return running(PROGRAM_NAMES.demo);
    }
    session.checkGame(name);
    say(session.runGame(name, files[session.gameFile(name)]));
    running(PROGRAM_NAMES[name]);
  });
  // what Programs offers on this machine: the no-ROM programs it runs (its own builds of LIZA and the Welcome menu)
  const offered = () => {
    const m = session.shownMachine, out = [];
    if (PROGRAM_FILES.includes(session.lizaFile)) out.push('liza');
    if (session.welcomeFile === 'welcome.bin' && PROGRAM_FILES.includes('demo.bin')) out.push('demo');   // the 6809 machines
    for (const g of Object.keys(GAMES.list)) { try { session.checkGame(g); if (PROGRAM_FILES.includes(session.gameFile(g))) out.push(g); } catch (e) { /* not on this machine */ } }
    if (PROGRAM_FILES.includes(session.welcomeFile)) out.push('welcome');
    return out;
  };
  const pickRoms = () => $('rom').click();
  // the Welcome menu's choices (its keys emit them, after the frame): as on the page, minus what the panel lacks
  const welcomeChoice = (choice) => {
    if (['liza', 'demo', '2048', 'minesweeper'].includes(choice)) runProgram(choice);
    else if (choice === 'roms') status('Add ROMs for BASIC from Programs or Machine.', { announce: true });
    else if (choice === 'claude') status('You are with Claude already: ask in the chat.', { announce: true });
  };
  session.on((ev) => {
    if (ev === 'machine') {
      input.setMachine(session.shownMachine);
      canvas.setAttribute('aria-label', `${session.shownMachine.profile.name} screen. Click or focus to type.`);
      now.program = null; describe();
    }
    if (['machine', 'firmware', 'reset', 'loaded'].includes(ev)) audio.discontinuity();
    if (typeof ev === 'string' && ev.startsWith('welcome:')) { const choice = ev.slice(8); setTimeout(() => welcomeChoice(choice)); }
  });
  session.switchMachine('dragon64', undefined, { menu: false });
  if (session.shownMachine.hasRom) say('Your ROMs are stored in this panel: BASIC starts. LIZA is in Programs.');
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
  // Claude's calls: the chip (acting or reading, by the tool's readOnlyHint), one short announcement per acting call
  // (none for reads), and the status line's action line after an acting one. The person's own keys and clicks never
  // come here.
  const tools = new Map(toolbox.tools().map((t) => [t.name, t]));
  const cue = chip({ bezel: $('bezel'), chip: $('chip'), text: $('chip-text'), keys: $('chip-keys'), left: $('chip-left') });
  let busy = false, typing = null, queue = Promise.resolve();
  const call = (name, args, { signal } = {}) => {
    const run = queue.then(async () => {
      busy = true;
      const t = tools.get(name), a = args || {};
      const d = describeCall(name, a, { read: !!(t && t.annotations && t.annotations.readOnlyHint), title: t ? t.title : name, model, program: (id) => PROGRAM_NAMES[id] || id });
      cue.start(d);
      const said = announcement(d);
      if (said) $('announce').textContent = said;
      if (name === 'type_text' && d.keys) { typing = { m: session.shownMachine, total: d.keys.length }; cue.typed(0); }
      try {
        const r = await toolbox.call(name, args, { signal, base64: toBase64 });
        if (!r.isError && name === 'load') now.program = a.program ? PROGRAM_NAMES[a.program] || a.program : String(a.path || '').split('/').pop();
        else if (!r.isError && name === 'assemble_and_load') now.program = 'Claude\'s program';
        if (keys) keys.apply();
        if (!d.read) status(`${d.past}${d.keys || ''} · ${clock(new Date())}`);
        return r;
      } finally {
        busy = false; typing = null; audio.discontinuity();
        cue.done();
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  let last = performance.now(), lines = 240;
  function tick(t) {
    requestAnimationFrame(tick);
    const m = session.shownMachine;
    if (!busy) session.advance(t - last, { onFrame: () => audio.pushFrame(m.audioEvents, m.frameCycles, m.fps), now: () => performance.now() });
    last = t;
    // Claude's keys, in its colour, as they reach the machine
    if (typing && typing.m === m) cue.typed(typing.total - Math.min(typing.total, pendingKeys(m)));
    const frame = m.render();
    if (frame.height !== lines) { lines = frame.height; fit(); }
    presenter.present(frame);
  }
  // the on-screen keys, on a touch screen (⋯ hides them and brings them back)
  const storage = (() => { try { return localStorage; } catch (e) { return null; } })();   // (the sandbox may refuse it)
  keys = touchPanel($('keys'), { session, input, wanted: touch, storage, program: programControls, onPress: () => unlock(), onChange: () => { syncKeysItem(); fit(); } });
  // the toolbar, the keys and the status line stay in view with the screen in a fixed-height view (Details, open,
  // scrolls), inside the insets; inline, the host is told the content's height (computed from the width)
  const bodyPad = () => { const b = getComputedStyle(document.body); return parseFloat(b.paddingTop) + parseFloat(b.paddingBottom); };
  const keysH = () => ($('keys').hidden ? 0 : $('keys').offsetHeight);
  fit = fitScreen($('stage'), $('bezel'), canvas, {
    context: () => bridge.hostContext || {},
    reserve: () => bodyPad() + $('bar').offsetHeight + keysH() + ($('details').open ? $('status').offsetHeight + 4 : $('foot').offsetHeight),
    around: () => bodyPad() + $('bar').offsetHeight + keysH() + $('foot').offsetHeight,
    onSize: ({ width, height }) => bridge.sizeChanged(width, height),
  });
  $('details').addEventListener('toggle', () => fit());
  coarse.addEventListener('change', () => syncMode());
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !touchSeen) { touchSeen = true; syncMode(); } }, { capture: true });
  requestAnimationFrame(tick);

  // sound: off until a click (browsers allow it only after one); the switch shows which, and its click is the gesture
  const syncSound = () => {
    const b = $('sound'), on = !!audio.ctx && audio.enabled;
    b.innerHTML = `${on ? SPEAKER_ON : SPEAKER_OFF}<span class="lbl">${on ? 'Sound on' : 'Sound off'}</span>`;
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Sound on: click to turn it off' : 'Sound off: click to turn it on';
    facts.audio = !audio.ctx ? 'off until a click' : `${on ? 'on' : 'muted'}, ${audio.path}${audio.fallback ? ` (${audio.fallback})` : ''}`;
    show();
  };
  function syncKeysItem() {
    const item = $('keys-item');
    item.hidden = !touch();
    item.textContent = keys && keys.hidden ? 'Show on-screen keys' : 'Hide on-screen keys';
    $('hint').hidden = !!(keys && keys.shown);   // (the keys are the way to type: "Click to type" would mislead)
  }
  syncKeysItem();
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
  menu($('programs'), programsMenu, {
    onOpen: () => {
      const items = offered().map((id) => menuItem(id === 'welcome' ? 'Welcome menu' : PROGRAM_NAMES[id], { attrs: { 'data-program': id } }));
      if (!session.machineRoms().bootable) {
        const sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        items.push(sep, menuItem('Add ROMs for BASIC…', { attrs: { 'data-action': 'roms' } }));
      }
      programsMenu.replaceChildren(...items);
    },
    onPick: (item) => {
      if (item.dataset.action === 'roms') return pickRoms();
      runProgram(item.dataset.program);
      canvas.focus();
    },
  });
  const machineMenu = $('machine-menu');
  menu($('machine'), machineMenu, {
    onOpen: () => {
      const cur = session.shownMachine.id, out = [];
      for (const [group, has] of GROUPS) {
        const ids = Object.keys(profiles).filter((id) => has(profiles[id]));
        if (!ids.length) continue;
        const g = document.createElement('div');
        g.className = 'group'; g.setAttribute('role', 'presentation'); g.textContent = group;
        out.push(g);
        for (const id of ids) {
          const basic = session.machineRoms(id).bootable;
          out.push(menuItem(profiles[id].name, { role: 'menuitemradio', tag: basic ? '✓ BASIC ready' : 'needs ROMs', tagOk: basic, attrs: { 'data-model': id, 'aria-checked': String(id === cur) } }));
        }
      }
      const sep = document.createElement('div');
      sep.setAttribute('role', 'separator');
      out.push(sep, menuItem('Reset', { attrs: { 'data-action': 'reset' } }), menuItem('Switch off and on', { attrs: { 'data-action': 'power' } }), menuItem('Add ROMs…', { attrs: { 'data-action': 'roms' } }));
      machineMenu.replaceChildren(...out);
    },
    onPick: (item) => {
      const act = item.dataset.action;
      if (act === 'roms') return pickRoms();
      if (act === 'reset') { session.reset(); describe(); }
      else if (act === 'power') { session.powerCycle({ menu: false }); now.program = null; describe(); }
      else {
        const id = item.dataset.model, m = session.shownMachine;
        if (id !== m.id) session.switchMachine(id, undefined, { menu: false });
        else if (session.storedRomsWaiting(m)) { session.useStoredRoms(m); session.powerCycle({ menu: false }); now.program = null; describe(); }
        // a model without its ROMs starts on the Welcome menu, as the page's machine menu does
        if (id !== m.id && !session.shownMachine.hasRom) runProgram('welcome');
      }
      canvas.focus();
    },
  });
  const copyDetails = async () => {
    const text = `${$('st').textContent}\n${$('msg').textContent}`.trim();
    try { await navigator.clipboard.writeText(text); status('Details copied.', { announce: true, brief: true }); return; } catch (e) { /* the sandbox may not allow it: try the old way */ }
    const t = document.createElement('textarea');
    t.value = text; document.body.append(t); t.select();
    const ok = document.execCommand && document.execCommand('copy');
    t.remove();
    status(ok ? 'Details copied.' : 'Could not copy: open Details and select the text.', { announce: true, brief: true });
  };
  menu($('more'), $('more-menu'), {
    onOpen: () => { $('details-item').textContent = $('details').open ? 'Hide details' : 'Details'; syncKeysItem(); },
    onPick: (item) => {
      if (item.id === 'keys-item') return keys.setHidden(!keys.hidden);
      if (item.id === 'big') bridge.requestDisplayMode('fullscreen').then((r) => say(`mode: ${r.mode}`), (er) => say(`refused: ${er.message || er}`));
      else if (item.id === 'details-item') { $('details').open = !$('details').open; if ($('details').open) $('details').firstElementChild.focus(); }
      else if (item.id === 'copy') copyDetails();
    },
  });
  // ROMs, optional: a file input or a drop. They stay in this panel's own storage (partitioned under the chat's
  // site) and are read only by the emulator: no tool takes or returns them
  async function addRoms(list) {
    const got = await Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    try {
      const r = session.addRoms(got);
      say(r.files.map((f) => `${f.name}: ${f.result}`).join('; ') + (session.shownMachine.hasRom ? ' — BASIC starts.' : ''));
      if (session.shownMachine.hasRom) { now.program = null; describe(); } else status('Those files are not ROMs this model takes: Details says what each one is.', { announce: true });
    } catch (e) { status(`ROMs: ${e.message}`, { announce: true }); }
  }
  $('rom').onchange = (e) => addRoms(e.target.files);
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addRoms(e.dataTransfer.files); });
  for (const id of ['programs', 'machine', 'sound', 'more']) $(id).disabled = false;
  canvas.setAttribute('aria-label', `${session.shownMachine.profile.name} screen. Click or focus to type.`);

  hostFacts();
  syncMode();
  bridge.attach({ api: PANEL_API, tools: toolbox.tools(), call });
  refused();
  facts.storage = `${await probeStorage()}; media store ${mediaNote}`;
  show();
  window.cloadmView = { session, toolbox, facts, loadedAt, audio, cue, keys };   // for the browser check
}
