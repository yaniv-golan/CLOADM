// Builds the side-panel connector's two views for the Worker (connector/worker/), with no dependencies and no build
// step anywhere else in the repository:
//   node connector/build.js          -> connector/worker/src/views.gen.js (git-ignored; wrangler's [build] runs this).
//                                       It first checks that https://cloadm.dev serves the same PANEL_API, and refuses
//                                       if not (the site, GitHub Pages building main, must be live first); --force, or
//                                       CLOADM_FORCE_DEPLOY=1 in the environment (wrangler runs the command itself),
//                                       skips that check, for a first deploy or a deliberate one.
//   views({ origin })                -> { site, inline, version, tools } (tests/connector.test.js, the browser check)
// The view's HTML is the same shell in both: the CLOADM_VIEW config, then the bridge (a classic script, so the
// handshake comes first), then the emulator as a module:
//   A, "site" (open_emulator):          one import of ORIGIN/connector/view/panel.js, which brings js/ from beside it:
//                                       the glue and the emulator always come from one release of the site. Its
//                                       _meta.ui.csp declares ORIGIN only. This view is not folded.
//   B, "inline" (open_emulator_inline): panel.js and its whole graph folded into the view (./fold.js), with the
//                                       bundled programs inline: nothing is fetched, and no CSP is declared.
// CLOADM_VIEW.tools is the panel's tool list as this build saw it, for the bridge to answer tools/list before the
// emulator has loaded; the emulator's own list replaces it (notifications/tools/list_changed). CLOADM_VIEW.api is
// PANEL_API as built: in A the bridge refuses a site whose panel.js speaks another (out-of-step).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './fold.js';
import { PANEL_API, PROGRAM_FILES, panelToolbox } from './view/tools.js';
import { Session } from '../js/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
export const ORIGIN = 'https://cloadm.dev';

// What this build is, for serverInfo and the view's appInfo: `git describe` of the checkout ("0.1.8" on a release's
// tag, "0.1.7-pre-3-gf42b010" for work after one, "-dirty" with uncommitted changes), never a release number the
// code is not; "unknown" outside a git checkout
export function version() {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^v/, '');
  } catch (e) { return 'unknown'; }
}

// Is the site serving the panel this build expects? fetchText(url) -> text. -> { ok, site, want, why }
export async function checkSite(fetchText, origin = ORIGIN) {
  const url = `${origin}/connector/view/tools.js`;
  let text;
  try { text = await fetchText(url); } catch (e) { return { ok: false, want: PANEL_API, site: null, why: `${url}: ${e.message}` }; }
  const m = /export const PANEL_API = (\d+);/.exec(text || '');
  if (!m) return { ok: false, want: PANEL_API, site: null, why: `${url} has no PANEL_API (is this release on the site yet?)` };
  const site = Number(m[1]);
  return site === PANEL_API ? { ok: true, want: PANEL_API, site } : { ok: false, want: PANEL_API, site, why: `${origin} serves PANEL_API ${site}, this build is ${PANEL_API}` };
}
// the panel's tools, as a panel on a Dragon 64 lists them (the list does not depend on the model)
export function panelTools() {
  const s = new Session({ welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  return panelToolbox(s, { png: () => null, program: () => null, now: () => 0, date: () => new Date(0), yield: async () => {} }).tools();
}
const programs = () => Object.fromEntries(PROGRAM_FILES.map((f) => [f, fs.readFileSync(path.join(repo, 'examples', f)).toString('base64')]));
// JSON inside a <script>: no "</script" or "<!--" can end or confuse it
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// The view's page: the toolbar (Programs, Machine, sound, Add ROMs, the side-panel button, and More with Reset), the
// screen in its bezel with the cue that shows when Claude drives the machine, a friendly status line, and the
// diagnostics behind a Details disclosure (docs/deploy-connector.md's verify step reads them there). panel.js fills
// the menus and wires everything; until it runs, the status says the emulator is starting (or why it did not).
const CSS = `:root{color-scheme:dark;--bg:#0f1210;--panel:#171b18;--line:#323a34;--text:#e3e9e3;--dim:#a3ada5;--accent:#7fd88f;--claude:#e8916c}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
#bar{display:flex;flex-wrap:wrap;gap:2px;padding:5px 6px;align-items:center;border-bottom:1px solid var(--line);background:var(--panel)}
#bar .grow{flex:1 1 0}
button{font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:6px;padding:4px 7px;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.5;cursor:default}
button:hover{background:#232925;border-color:var(--line)}
button:focus-visible,summary:focus-visible,#screen:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button[aria-expanded="true"]{background:#232925;border-color:var(--line)}
#big{border-color:var(--line)}#sound{padding:3px 6px;line-height:0}#sound svg{width:18px;height:18px}
@media (max-width:460px){#big .wide{display:none}}
.menu{position:relative}
[role="menu"]{position:absolute;z-index:3;top:calc(100% + 4px);left:0;min-width:200px;max-width:calc(100vw - 12px);max-height:70vh;overflow:auto;padding:4px;margin:0;background:#1d221e;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px #000a}
#more-menu{left:auto;right:0}
[role="menu"][hidden]{display:none}
[role^="menuitem"]{display:flex;width:100%;gap:8px;justify-content:space-between;align-items:baseline;text-align:left;border-radius:5px}
[role^="menuitem"]:focus{outline:none;background:#2b332d;border-color:var(--accent)}
[role^="menuitem"][aria-disabled="true"]{color:var(--dim)}
[role="menuitemradio"]::before{content:"";width:1em;flex:none}[role="menuitemradio"][aria-checked="true"]::before{content:"✓";color:var(--accent)}
[role="menu"] .label{flex:1}[role="menu"] .tag{font-size:11px;color:var(--dim)}[role="menu"] .tag.ok{color:var(--accent)}
[role="menu"] [role="separator"]{border-top:1px solid var(--line);margin:4px 2px}
[role="menu"] .group{font-size:11px;color:var(--dim);padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.04em}
#stage{display:grid;place-items:center;padding:8px 8px 4px}
#bezel{position:relative;padding:10px;border-radius:14px;background:linear-gradient(#1f2420,#141815);box-shadow:inset 0 1px 0 #ffffff14,0 0 0 1px #000,0 6px 18px #0008}
#screen{display:block;width:320px;height:240px;image-rendering:pixelated;image-rendering:crisp-edges;background:#000;border-radius:4px;outline:none}
#hint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:3px 10px;border-radius:999px;background:#000b;color:var(--text);font-size:12px;pointer-events:none}
#bezel:focus-within #hint{display:none}
#activity{position:absolute;left:50%;top:16px;transform:translateX(-50%);max-width:calc(100% - 32px);display:flex;gap:6px;align-items:center;padding:4px 12px;border-radius:999px;background:#2a1a12f0;border:1px solid var(--claude);color:#ffe9de;font-size:12px;box-shadow:0 4px 14px #000a;transition:opacity .4s}
#activity.fading{opacity:0}#activity[hidden]{display:none}
#activity .who{color:var(--claude);font-weight:600}
#activity kbd{font:12px ui-monospace,monospace;background:#0008;border-radius:4px;padding:1px 5px;white-space:pre;overflow:hidden;text-overflow:ellipsis}
#foot{padding:2px 10px 6px;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
#status{margin:0;flex:1 1 auto;color:var(--text)}#status button{border-color:var(--line);padding:1px 8px;margin-left:6px}
#details{color:var(--dim)}#details summary{cursor:pointer;font-size:12px;border-radius:4px;padding:0 4px}
#details[open]{flex-basis:100%}
#st,#msg{padding:2px 4px;font:11px ui-monospace,monospace;color:var(--dim);word-break:break-word}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

function shell(cfg, module) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLOADM</title>
<style>${CSS}</style></head><body>
<div id="bar" role="toolbar" aria-label="CLOADM">
<div class="menu"><button id="programs" aria-haspopup="menu" aria-expanded="false" aria-controls="programs-menu" disabled>Programs ▾</button><div id="programs-menu" role="menu" aria-label="Programs" hidden></div></div>
<div class="menu"><button id="machine" aria-haspopup="menu" aria-expanded="false" aria-controls="machine-menu" disabled>Machine ▾</button><div id="machine-menu" role="menu" aria-label="Machine" hidden></div></div>
<button id="sound" aria-pressed="false" aria-label="Sound" title="Sound is off until you click" disabled></button>
<button id="roms" disabled>Add ROMs…</button><input id="rom" type="file" multiple hidden>
<span class="grow"></span>
<button id="big" aria-label="Open in side panel" title="Open in side panel" hidden>⤢<span class="wide"> Open in side panel</span></button>
<div class="menu"><button id="more" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" aria-label="More" disabled>⋯</button><div id="more-menu" role="menu" aria-label="More" hidden><button id="reset" role="menuitem" tabindex="-1">Reset</button></div></div>
</div>
<div id="stage"><div id="bezel"><canvas id="screen" tabindex="0" width="320" height="240" aria-label="The emulated screen: click it, then type"></canvas>
<div id="hint" aria-hidden="true">Click the screen to type</div>
<div id="activity" role="status" aria-live="polite" hidden><span class="who">Claude</span><span id="activity-what"></span><kbd id="activity-keys" hidden></kbd></div></div></div>
<div id="foot"><p id="status" role="status" aria-live="polite">Starting CLOADM…</p>
<details id="details"><summary>Details</summary><div id="msg"></div><div id="st">loading (${cfg.variant})…</div></details></div>
<script>globalThis.CLOADM_VIEW = ${scriptJson(cfg)};</script>
<script>
${fs.readFileSync(path.join(here, 'view/bridge.js'), 'utf8')}</script>
<script>const startFailed = (why) => { document.getElementById('st').textContent = 'error: ' + why; document.getElementById('status').textContent = window.cloadmView ? 'Something went wrong. Details says what.' : 'CLOADM could not start. Details says why.'; CLOADM_BRIDGE.fail(why); };
addEventListener('error', (e) => startFailed(e.message || (e.target && (e.target.src || e.target.href)) || String(e)), true);
addEventListener('unhandledrejection', (e) => startFailed(String((e.reason && e.reason.message) || e.reason)));</script>
${module}
</body></html>`;
}

export function views({ origin = ORIGIN } = {}) {
  const base = { api: PANEL_API, version: version(), tools: panelTools() };
  const site = shell(Object.assign({ variant: 'site' }, base),
    `<script type="module">import(${JSON.stringify(`${origin}/connector/view/panel.js`)}).then((m) => m.start()).catch((e) => startFailed(e.message));</script>`);
  const { code, modules } = fold(path.join(here, 'view/panel.js'), { tail: '__ENTRY__.start().catch((e) => startFailed(e.message));\n' });
  const inline = shell(Object.assign({ variant: 'inline', programs: programs() }, base), `<script type="module">\n${code}</script>`);
  return { site, inline, modules, version: base.version, tools: base.tools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes('--force') || process.env.CLOADM_FORCE_DEPLOY === '1';
  const r = await checkSite(async (url) => { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); });
  if (!r.ok && !force) {
    console.error(`refusing to build the connector: ${r.why}. Publish this release on the site first (GitHub Pages builds main), or build with --force / CLOADM_FORCE_DEPLOY=1 (a first deploy).`);
    process.exit(1);
  }
  if (!r.ok) console.error(`warning: ${r.why} (forced)`);
  const v = views();
  const out = path.join(here, 'worker/src/views.gen.js');
  fs.writeFileSync(out, `// generated by connector/build.js; do not edit\nexport default ${JSON.stringify({ site: v.site, inline: v.inline, version: v.version })};\n`);
  const { gzipSync } = await import('node:zlib');
  const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`site view ${kb(v.site.length)}; inline view ${kb(v.inline.length)} (${v.modules} modules, gzip ${kb(gzipSync(v.inline).length)}); version ${v.version}`);
}
