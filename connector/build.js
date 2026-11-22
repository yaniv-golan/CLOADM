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

// The view's page (R29): a one-row toolbar (Programs, Machine, Sound, and ⋯ with Open in side panel, Details and Copy
// details), the screen in a thin bezel with its "Click to type" chip and Claude's chip, ONE status line, and the
// diagnostics behind Details (closed at first; docs/deploy-connector.md's verify step reads them there). panel.js fills
// the menus and wires everything; until it runs, the status line says the emulator is starting (or why it did not:
// errors the person must act on stay on that line).
const CSS = `:root{color-scheme:dark;--bg:#0B0D0C;--panel:#141816;--line:#263029;--line2:#3A4540;--text:#E8EDE6;--dim:#9AA59C;--claude:#D97757;--claude-ink:#141413;--claude-edge:#B85C3E;--focus:#C9D2C8}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#bar{display:flex;flex-wrap:nowrap;gap:2px;padding:4px 6px;align-items:center;border-bottom:1px solid var(--line);background:var(--panel)}
#bar .grow{flex:1 1 0}
button{font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:6px;padding:4px 8px;cursor:pointer;white-space:nowrap}
button:hover,button[aria-expanded="true"]{background:#1F2622;border-color:var(--line2)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
#sound{display:inline-flex;gap:5px;align-items:center}#sound svg{width:16px;height:16px;flex:none}
#sound[aria-pressed="true"]{border-color:var(--line2)}
@media (max-width:460px){#sound .lbl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
.menu{position:relative}
[role="menu"]{position:absolute;z-index:3;top:calc(100% + 4px);left:0;min-width:200px;max-width:calc(100vw - 12px);max-height:70vh;overflow:auto;padding:4px;margin:0;background:#1A201C;border:1px solid var(--line2);border-radius:8px;box-shadow:0 8px 24px #000a}
#more-menu{left:auto;right:0}
[role="menu"][hidden]{display:none}
[role^="menuitem"]{display:flex;width:100%;gap:10px;justify-content:space-between;align-items:baseline;text-align:left;border-radius:5px}
[role^="menuitem"][hidden]{display:none}
[role^="menuitem"]:focus{outline:none;background:#26302A;border-color:var(--focus)}
[role="menuitemradio"]::before{content:"";width:.8em;flex:none}[role="menuitemradio"][aria-checked="true"]::before{content:"●";font-size:.7em}
[role="menu"] .label{flex:1}[role="menu"] .tag{font-size:11px;color:var(--dim)}[role="menu"] .tag.ok{color:#3DF55A}
[role="menu"] [role="separator"]{border-top:1px solid var(--line2);margin:4px 2px}
[role="menu"] .group{font-size:11px;color:var(--dim);padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.04em}
#stage{display:flex;justify-content:center;padding:4px}
#bezel{position:relative;padding:8px;border-radius:10px;background:linear-gradient(180deg,#3A3F3D,#1C201E);box-shadow:inset 0 1px 0 #ffffff1f}
#bezel.claude{box-shadow:inset 0 1px 0 #ffffff1f,0 0 0 2px var(--claude),0 0 16px #D9775799}
:root[data-theme="light"] #bezel.claude{outline:1px solid var(--claude-edge);outline-offset:2px}
#screen{display:block;width:320px;height:240px;image-rendering:pixelated;image-rendering:crisp-edges;background:#000;border-radius:3px;outline:none}
#screen:focus-visible{box-shadow:0 0 0 2px var(--focus)}
#hint{position:absolute;right:14px;bottom:14px;padding:2px 9px;border-radius:999px;background:#000c;border:1px solid var(--line2);color:var(--text);font-size:12px;pointer-events:none}
#bezel:focus-within #hint{display:none}
#chip{position:absolute;left:14px;top:14px;max-width:calc(100% - 28px);padding:3px 9px;border-radius:6px;background:var(--claude);color:var(--claude-ink);font:12px/1.4 ui-monospace,"JetBrains Mono",monospace;white-space:pre;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px #0008}
#chip.read{border:1px solid var(--line2);color:var(--focus);background:var(--bg)}
#chip[hidden]{display:none}
#chip-keys{color:var(--claude-ink);font-weight:700}#chip-left{color:var(--claude-ink);text-decoration:underline dotted}
#chip .cursor{display:inline-block;width:.55em;height:1em;vertical-align:-2px;margin-left:1px;background:var(--claude-ink);animation:blink 1s steps(1) infinite}
#chip.read .cursor,#chip.done .cursor,#chip.nokeys .cursor{display:none}
@keyframes blink{50%{opacity:0}}
#foot{padding:0 10px 4px;display:flex;flex-wrap:wrap;gap:0 12px;align-items:baseline;min-height:22px}
#status{margin:0;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#status.error{white-space:normal;color:#FFB4A8}
#details{color:var(--dim);flex:none}#details summary{cursor:pointer;font-size:12px;border-radius:4px;width:max-content;margin-left:auto}
#details[open]{flex-basis:100%}
#st,#msg{padding:2px 0;font:11px ui-monospace,monospace;color:var(--dim);word-break:break-word}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

function shell(cfg, module) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLOADM</title>
<style>${CSS}</style></head><body>
<div id="bar" role="toolbar" aria-label="CLOADM">
<div class="menu"><button id="programs" aria-haspopup="menu" aria-expanded="false" aria-controls="programs-menu" disabled>Programs ▾</button><div id="programs-menu" role="menu" aria-label="Programs" hidden></div></div>
<div class="menu"><button id="machine" aria-haspopup="menu" aria-expanded="false" aria-controls="machine-menu" disabled>Machine ▾</button><div id="machine-menu" role="menu" aria-label="Machine" hidden></div></div>
<button id="sound" aria-pressed="false" disabled><span class="lbl">Sound off</span></button><input id="rom" type="file" multiple hidden>
<span class="grow"></span>
<div class="menu"><button id="more" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" aria-label="More" disabled>⋯</button><div id="more-menu" role="menu" aria-label="More" hidden>
<button id="big" role="menuitem" tabindex="-1" hidden>Open in side panel</button><button id="details-item" role="menuitem" tabindex="-1">Details</button><button id="copy" role="menuitem" tabindex="-1">Copy details</button></div></div>
</div>
<div id="stage"><div id="bezel"><canvas id="screen" tabindex="0" width="320" height="240" aria-label="CLOADM screen. Click or focus to type."></canvas>
<div id="hint" aria-hidden="true">Click to type</div>
<div id="chip" aria-hidden="true" hidden><span id="chip-text"></span><span id="chip-keys"></span><span class="cursor"></span><span id="chip-left"></span></div></div></div>
<div id="foot"><p id="status">Starting CLOADM…</p>
<details id="details"><summary>Details</summary><div id="msg"></div><div id="st">loading (${cfg.variant})…</div></details></div>
<div id="announce" class="sr" aria-live="polite"></div>
<script>globalThis.CLOADM_VIEW = ${scriptJson(cfg)};</script>
<script>
${fs.readFileSync(path.join(here, 'view/bridge.js'), 'utf8')}</script>
<script>const startFailed = (why) => { document.getElementById('st').textContent = 'error: ' + why; const s = document.getElementById('status'); s.className = 'error'; s.textContent = window.cloadmView ? 'Something went wrong: ' + why : 'CLOADM could not start: ' + why + '. Ask Claude to open it again, or with open_emulator_inline.'; document.getElementById('announce').textContent = s.textContent; CLOADM_BRIDGE.fail(why); };
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
