/*
 * URL configuration: every setting a link can carry, read and checked here without a browser,
 * and written back the same way (share links, the embed snippet). Every link points at /play.
 *
 *   parseUrlConfig(search, fallbackMachine) -> { machine, config, display, media, autorun, roms, start, app, nitros9, embed,
 *                                                askClaude, sound, joy, fastTape, turbo, selftest, errors }
 *   buildUrl(base, cfg) -> the link for cfg (parseUrlConfig of it gives cfg back)
 *
 * Parameters (URL_PARAMS lists them):
 *   machine=ID              a model of profiles.js (unknown: the fallback machine, and an error)
 *   <option>=VALUE          the model's options (profile.options: ram, cpu, ...), each checked against its values
 *   start=welcome|liza|2048|minesweeper
 *                           run that program, with no welcome menu first (the games on 6809 machines; elsewhere the
 *                           status line says why); it stays in the address while the program runs and goes once it
 *                           is left, as app=claude does for the chat (js/ui/welcome.js)
 *   nitros9=1|NAME          CoCo 3: boot NitrOS-9 over DriveWire from the user's own image in the library (1: the
 *                           one in DriveWire drive 0, else the bootable one for the link's CPU; NAME: that image).
 *                           The image itself is never in a link (Session.bootNitros9)
 *   app=claude              open the Claude chat (with start= too: the chat, and start= is ignored, saying so): the chat firmware on a 6809 machine, and the
 *                           chat's panel (API key, machine tools) beside the screen (js/ui/claude.js)
 *   load=URL                load and run a program, tape or cartridge, as a dropped file would
 *   tape=URL                put a tape in the deck; with autorun it loads and runs (CLOAD/RUN, or CLOADM then EXEC)
 *   cart=URL                plug in a cartridge (it starts by itself)
 *   autorun[=1|0]           with tape=
 *   rom=URL (repeatable)    a ROM image to fetch (never from the Color Computer Archive; js/ui/rom-panel.js)
 *   selftest=1              with rom=: run the ROM self-test
 *   display=crt|sharp, phase=1|2, aspect=4:3|fill, integer=1|0, curvature=0..100, glow=0..100
 *                           the Display tab's settings, for this visit only (never stored)
 *   joy=mouse|off           the mouse as the right joystick
 *   touch=joystick|keys     the on-screen panel's mode on a touch screen (joystick: the touch stick, keys: the
 *                           keyboard alone); not for embeds (a page the site puts in an iframe has no touch panel)
 *   sound=1|0, fasttape=1|0, turbo=1|0
 *   embed=1                 embed mode: the screen only, driven by the page around it (js/embed-api.js)
 *   askclaude=1             with embed=1: draw a small "Ask Claude ↗" chip in the screen's corner, a link that opens
 *                           this moment in a new tab with the chat (js/ui/ask-popout.js). Off by default
 *   storage=opfs|fsa|fallback  where ROMs and programs are kept (js/host/media-store-open.js)
 * Errors are messages for the status line; a bad value is ignored, the rest of the link still applies.
 */
import { profiles } from './machines/profiles.js';

// the machines NitrOS-9 boots on from a link (the Session's Session.NITROS9_MACHINES)
export const NITROS9_MACHINES = ['coco3'];

export const DISPLAY_PARAMS = {
  display: { key: 'view', values: ['crt', 'sharp'] },
  phase: { key: 'phase', values: [1, 2] },
  aspect: { key: 'aspect', values: ['4:3', 'fill'] },
  integer: { key: 'integer', flag: true },
  curvature: { key: 'curvature', range: [0, 100] },
  glow: { key: 'glow', range: [0, 100] },
};
const FLAGS = { sound: 'sound', fasttape: 'fastTape', turbo: 'turbo', embed: 'embed', selftest: 'selftest', askclaude: 'askClaude' };
const MEDIA = ['load', 'tape', 'cart'];
export const URL_PARAMS = ['machine', 'start', 'app', 'nitros9', ...MEDIA, 'autorun', 'rom', ...Object.keys(DISPLAY_PARAMS), 'joy', 'touch', ...Object.keys(FLAGS), 'storage'];
const STORAGE = ['opfs', 'fsa', 'fallback'];
const STARTS = ['welcome', 'liza', '2048', 'minesweeper'];
const APPS = ['claude'];
const TOUCH_MODES = ['joystick', 'keys'];

// '' (present without a value), 1/0, true/false -> boolean; anything else -> null
const flag = (v) => (v === '' || v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null);
const isUrl = (v) => { try { return !!new URL(v, 'https://cloadm.dev/'); } catch (e) { return false; } };

export function parseUrlConfig(search, fallbackMachine = 'dragon64') {
  const p = new URLSearchParams(search), errors = [];
  const cfg = { machine: null, config: {}, display: {}, media: [], autorun: false, roms: [], start: null, app: null, nitros9: null, joy: null, touch: null, storage: null, errors };
  for (const k of Object.values(FLAGS)) cfg[k] = null;

  // a NitrOS-9 link without a machine means the CoCo 3, where it boots
  const id = p.get('machine') ?? (p.has('nitros9') ? NITROS9_MACHINES[0] : null);
  // (the fallback machine opens, and the message says which: the list of every machine made a toast of a whole paragraph)
  cfg.machine = id !== null && profiles[id] ? id : null;
  const profile = profiles[cfg.machine || fallbackMachine] || profiles.dragon64;
  if (id !== null && !profiles[id]) errors.push(`machine=${id}: no such machine (opened ${profile.name} instead)`);

  // the model's options, checked against its values
  const options = profile.options || {};
  for (const [k, o] of Object.entries(options)) {
    if (!p.has(k)) continue;
    const raw = p.get(k), t = typeof o.values[0];
    const v = t === 'number' ? Number(raw) : t === 'boolean' ? flag(raw) : raw;
    if (o.values.includes(v)) cfg.config[k] = v;
    else errors.push(`${k}=${raw}: the ${profile.name} has ${o.values.map((x) => `${x}${o.unit || ''}`).join(' or ')}`);
  }
  // known parameters that aren't options of this model
  for (const k of new Set(p.keys())) {
    if (URL_PARAMS.includes(k) || options[k]) continue;
    const other = Object.values(profiles).some((pr) => pr.options && pr.options[k]);
    errors.push(other ? `${k}: the ${profile.name} has no such option` : `${k}: not a CLOADM setting (ignored)`);
  }

  const start = p.get('start');
  if (start !== null) { if (STARTS.includes(start)) cfg.start = start; else errors.push(`start=${start} isn't a start CLOADM has (${STARTS.join(', ')})`); }
  const app = p.get('app');
  if (app !== null) { if (APPS.includes(app)) cfg.app = app; else errors.push(`app=${app} isn't an app CLOADM has (${APPS.join(', ')})`); }
  // both: the app wins (it takes the screen), and start= is not run behind it
  if (cfg.app && cfg.start) { errors.push(`start=${cfg.start} is ignored: app=${cfg.app} opens instead`); cfg.start = null; }
  // nitros9: true (the image the user has) or an image's name; only where NitrOS-9 boots (the CoCo 3)
  if (p.has('nitros9')) {
    const v = p.get('nitros9');
    if (!NITROS9_MACHINES.includes(profile.id)) errors.push(`nitros9: NitrOS-9 boots on the CoCo 3 (machine=coco3), not the ${profile.name}`);
    else if (v === '' || v === '1') cfg.nitros9 = true;
    else if (v === '0') cfg.nitros9 = null;
    else if (/^[^\\/\x00-\x1F]{1,200}$/.test(v)) cfg.nitros9 = v;
    else errors.push(`nitros9=${v}: 1 or the name of a DriveWire image in your library`);
  }
  // media in the order the link gives them (the order they load in)
  for (const [kind, url] of p) {
    if (!MEDIA.includes(kind)) continue;
    if (url && isUrl(url)) cfg.media.push({ kind, url });
    else errors.push(`${kind}=${url}: not a link to a file`);
  }
  if (p.has('autorun')) { const f = flag(p.get('autorun')); if (f === null) errors.push(`autorun=${p.get('autorun')}: 1 or 0`); else cfg.autorun = f; }
  for (const url of p.getAll('rom')) { if (url && isUrl(url)) cfg.roms.push(url); else errors.push(`rom=${url}: not a link to a file`); }

  for (const [name, d] of Object.entries(DISPLAY_PARAMS)) {
    if (!p.has(name)) continue;
    const raw = p.get(name);
    let v = null;
    if (d.flag) v = flag(raw);
    else if (d.range) { const n = Number(raw); v = raw !== '' && Number.isInteger(n) && n >= d.range[0] && n <= d.range[1] ? n : null; }
    else { const c = typeof d.values[0] === 'number' ? Number(raw) : raw; v = d.values.includes(c) ? c : null; }
    if (v === null) errors.push(`${name}=${raw}: ${d.flag ? '1 or 0' : d.range ? `a whole number from ${d.range[0]} to ${d.range[1]}` : d.values.join(' or ')}`);
    else cfg.display[d.key] = v;
  }
  if (p.has('joy')) { const j = p.get('joy'); if (j === 'mouse' || j === 'off') cfg.joy = j; else errors.push(`joy=${j}: mouse or off`); }
  // touch: the on-screen panel's mode. An embed has no touch panel of its own (the page around it drives the
  // machine), so a link that embeds is told it does not apply rather than silently carrying a setting nothing reads.
  if (p.has('touch')) {
    const t = p.get('touch');
    if (!TOUCH_MODES.includes(t)) errors.push(`touch=${t}: joystick or keys`);
    else if (flag(p.get('embed')) === true) errors.push(`touch=${t}: an embedded page has no on-screen panel`);
    else cfg.touch = t;
  }
  if (p.has('storage')) { const st = p.get('storage'); if (STORAGE.includes(st)) cfg.storage = st; else errors.push(`storage=${st}: ${STORAGE.join(', ')}`); }
  for (const [name, key] of Object.entries(FLAGS)) {
    if (!p.has(name)) continue;
    const f = flag(p.get(name));
    if (f === null) errors.push(`${name}=${p.get(name)}: 1 or 0`); else cfg[key] = f;
  }
  // the corner chip is the embed's: the full page has Ask Claude in its app bar (a link to a new tab when framed)
  if (cfg.askClaude && cfg.embed !== true) { errors.push('askclaude=1: only with embed=1 (the full page has Ask Claude in its app bar)'); cfg.askClaude = null; }
  return cfg;
}

// What a failed fetch of a link's file (load=, tape=, cart=, rom=) says. The browser reports a network failure and a
// cross-origin refusal alike as a TypeError ("Failed to fetch", "Load failed"), which tells a person nothing; the usual
// cause for a link to another site is that the site doesn't allow other sites to load its files (CORS). An HTTP error
// status is not a TypeError and keeps its own words.
export const linkFetchError = (e) => (e instanceof TypeError ? "Couldn't download it: the site may not allow other sites to load its files." : e.message);

// the link for cfg (the shape parseUrlConfig returns; missing parts are left out), parameters in a fixed order
export function buildUrl(base, cfg) {
  const u = new URL(base);
  u.search = '';
  const s = u.searchParams;
  if (cfg.machine) s.set('machine', cfg.machine);
  const options = (profiles[cfg.machine] || {}).options || {};
  for (const [k, o] of Object.entries(options)) {
    const v = cfg.config && cfg.config[k];
    if (v !== undefined) s.set(k, typeof o.values[0] === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  if (cfg.start) s.set('start', cfg.start);
  if (cfg.app) s.set('app', cfg.app);
  if (cfg.nitros9) s.set('nitros9', cfg.nitros9 === true ? '1' : cfg.nitros9);
  for (const m of cfg.media || []) s.append(m.kind, m.url);
  if (cfg.autorun) s.set('autorun', '1');
  for (const r of cfg.roms || []) s.append('rom', r);
  for (const [name, d] of Object.entries(DISPLAY_PARAMS)) {
    const v = cfg.display && cfg.display[d.key];
    if (v !== undefined) s.set(name, d.flag ? (v ? '1' : '0') : String(v));
  }
  if (cfg.joy) s.set('joy', cfg.joy);
  if (cfg.touch) s.set('touch', cfg.touch);
  for (const [name, key] of Object.entries(FLAGS)) if (cfg[key] === true || cfg[key] === false) s.set(name, cfg[key] ? '1' : '0');
  if (cfg.storage) s.set('storage', cfg.storage);
  return u.toString();
}

// Whether the in-page Claude chat may be offered. A page shown inside someone else's page is not the person's own visit:
// the chat puts an API key card on screen, and the page around it would see and drive that. So the chat needs BOTH a
// top-level page and no embed flag. `framed` is the page's answer to "is this shown inside another page" (in a browser:
// window.self !== window.top). It fails CLOSED: only a page that says plainly it is top-level gets the chat, so `true`,
// `undefined`, or anything else means framed - a page that cannot tell is treated as shown inside another page.
// (The claude.ai connector view is unaffected: it is its own document, not this page, and it never sets up the chat.)
export const claudeOffered = (link, framed) => !(link && link.embed) && framed === false;
