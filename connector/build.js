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
//                                       _meta.ui.csp declares ORIGIN only. This view is not folded. It also carries
//                                       ./view/reach.js, which tells a blocked load (the host keeps ORIGIN out) to
//                                       the person and to Claude, who then opens B.
//   B, "inline" (open_emulator_inline): panel.js and its whole graph folded into the view (./fold.js), with the
//                                       bundled programs inline: nothing is fetched, and no CSP is declared.
// CLOADM_VIEW.tools is the panel's tool list as this build saw it, for the bridge to answer tools/list before the
// emulator has loaded; the emulator's own list replaces it (notifications/tools/list_changed). CLOADM_VIEW.api is
// PANEL_API as built: in A the bridge refuses a site whose panel.js speaks another (out-of-step).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
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
// What the connector's Claude needs to know, ONE source: the text between the markers in skills/cloadm/SKILL.md
// (the "connector essentials" section). It becomes the Worker's MCP `instructions` at build time (views().instructions,
// written into views.gen.js); the Worker has no copy of its own (connector/worker/src/server.js). The build prints its
// hash, and tests/connector.test.js and tests/skill.test.js fail on any drift between the skill and what the Worker serves.
export const ESSENTIALS_START = '<!-- connector-essentials:start -->', ESSENTIALS_END = '<!-- connector-essentials:end -->';
export function essentials(skillText = fs.readFileSync(path.join(repo, 'skills/cloadm/SKILL.md'), 'utf8')) {
  const at = (m) => skillText.split(m).length - 1;
  if (at(ESSENTIALS_START) !== 1 || at(ESSENTIALS_END) !== 1) throw new Error(`skills/cloadm/SKILL.md must hold exactly one ${ESSENTIALS_START} and one ${ESSENTIALS_END}`);
  const a = skillText.indexOf(ESSENTIALS_START) + ESSENTIALS_START.length, b = skillText.indexOf(ESSENTIALS_END);
  if (b < a) throw new Error('the connector-essentials end marker comes before its start marker');
  const text = skillText.slice(a, b).trim();
  if (!text) throw new Error('the connector-essentials section is empty');
  return text;
}
export const essentialsHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
const programs = () => Object.fromEntries(PROGRAM_FILES.map((f) => [f, fs.readFileSync(path.join(repo, 'examples', f)).toString('base64')]));
// JSON inside a <script>: no "</script" or "<!--" can end or confuse it
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// The view's page: a one-row toolbar (Programs, Machine, Sound, and ⋯ with Open in side panel, Details and Copy
// details), the screen in a thin bezel with its "Click to type" chip and Claude's chip, ONE status line, and the
// diagnostics behind Details (closed at first; docs/deploy-connector.md's verify step reads them there). panel.js fills
// the menus and wires everything; until it runs, the status line says the emulator is starting (or why it did not:
// errors the person must act on stay on that line).
const CSS = `:root{color-scheme:dark;--bg:#0B0D0C;--panel:#141816;--line:#263029;--line2:#3A4540;--text:#E8EDE6;--dim:#9AA59C;--claude:#D97757;--claude-ink:#141413;--claude-edge:#B85C3E;--focus:#C9D2C8}
*{box-sizing:border-box}html,body{margin:0}
body{padding:var(--in-t,0) var(--in-r,0) var(--in-b,0) var(--in-l,0);background:var(--bg);color:var(--text);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
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
#keys{padding:2px 6px 6px;display:flex;flex-direction:column;gap:4px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
#keys[hidden],#keys [hidden]{display:none!important}
#keys .kfull{display:flex;flex-direction:column;gap:4px}
#keys .krow{display:flex;gap:3px}
#keys .k{flex:1 1 0;min-width:0;height:40px;padding:0;border:1px solid var(--line);border-radius:6px;background:#1C221E;font-weight:600;font-size:15px;touch-action:none;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}
#keys .k.wide{flex:1.7 1 0;font-size:12px}#keys .k.space{flex:2.4 1 0}#keys .k small{font-size:9px;color:var(--dim)}
#keys .k.down{background:#3A4540;border-color:var(--focus)}#keys .k[aria-pressed="true"]{background:#26302A;border-color:var(--focus)}
#keys .kpadmode{display:flex;gap:8px}
#keys .karrows{flex:1.3 1 0;display:grid;grid-template-columns:repeat(3,1fr);gap:3px}#keys .karrows .k{height:48px;font-size:20px}
#keys .kpadkeys{flex:1 1 0;display:grid;grid-template-columns:1fr 1fr;gap:3px;align-content:start}#keys .kpadkeys .k{height:48px}#keys .kextras{display:contents}
#keys .kstick{display:flex;gap:6px}
#keys .kpad{position:relative;flex:1 1 0;height:132px;border:2px dashed var(--line2);border-radius:10px;background:#111412;touch-action:none;overflow:hidden}
#keys .kknob{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:#2A302C;border:2px solid var(--line2);pointer-events:none}
#keys .kknob.live{background:#3A403C;border-color:var(--focus)}
#keys .kfire{flex:0 0 38%;height:132px;border:0;border-radius:10px;background:#B3261E;color:#fff;font-size:20px;font-weight:800;touch-action:none}
#keys .kfire.down{background:#7A1B14}
#keys .kmode{display:flex;flex:2.6 1 0;border:1px solid var(--line2);border-radius:6px;overflow:hidden}
#keys .kmode button{flex:1;border:0;border-radius:0;height:38px;padding:0 4px}#keys .kmode button[aria-pressed="true"]{background:#26302A;color:var(--text);font-weight:600}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

function shell(cfg, module, extra = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLOADM</title>
<style>${CSS}</style></head><body>
<div id="bar" role="toolbar" aria-label="CLOADM">
<div class="menu"><button id="programs" aria-haspopup="menu" aria-expanded="false" aria-controls="programs-menu" disabled>Programs ▾</button><div id="programs-menu" role="menu" aria-label="Programs" hidden></div></div>
<div class="menu"><button id="machine" aria-haspopup="menu" aria-expanded="false" aria-controls="machine-menu" disabled>Machine ▾</button><div id="machine-menu" role="menu" aria-label="Machine" hidden></div></div>
<button id="sound" aria-pressed="false" disabled><span class="lbl">Sound off</span></button><input id="rom" type="file" multiple hidden>
<span class="grow"></span>
<div class="menu"><button id="more" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" aria-label="More" disabled>⋯</button><div id="more-menu" role="menu" aria-label="More" hidden>
<button id="big" role="menuitem" tabindex="-1" hidden>Open in side panel</button><button id="keys-item" role="menuitem" tabindex="-1" hidden>Hide on-screen keys</button><button id="details-item" role="menuitem" tabindex="-1">Details</button><button id="copy" role="menuitem" tabindex="-1">Copy details</button></div></div>
</div>
<div id="stage"><div id="bezel"><canvas id="screen" tabindex="0" width="320" height="240" aria-label="CLOADM screen. Click or focus to type."></canvas>
<div id="hint" aria-hidden="true">Click to type</div>
<div id="chip" aria-hidden="true" hidden><span id="chip-text"></span><span id="chip-keys"></span><span class="cursor"></span><span id="chip-left"></span></div></div></div>
<div id="keys" aria-label="On-screen keys" hidden></div>
<div id="foot"><p id="status">Starting CLOADM…</p>
<details id="details"><summary>Details</summary><div id="msg"></div><div id="st">loading (${cfg.variant})…</div></details></div>
<div id="announce" class="sr" aria-live="polite"></div>
<script>globalThis.CLOADM_VIEW = ${scriptJson(cfg)};</script>
<script>
${fs.readFileSync(path.join(here, 'view/bridge.js'), 'utf8')}</script>
${extra}<script>const startFailed = (why) => { if (window.CLOADM_REACH && CLOADM_REACH.blocked) return; document.getElementById('st').textContent = 'error: ' + why; const s = document.getElementById('status'); s.className = 'error'; s.textContent = window.cloadmView ? 'Something went wrong: ' + why : 'CLOADM could not start: ' + why + '. Ask Claude to open it again, or to open the offline copy.'; document.getElementById('announce').textContent = s.textContent; CLOADM_BRIDGE.fail(why); };
addEventListener('error', (e) => startFailed(e.message || (e.target && (e.target.src || e.target.href)) || String(e)), true);
addEventListener('unhandledrejection', (e) => startFailed(String((e.reason && e.reason.message) || e.reason)));</script>
${module}
</body></html>`;
}

export function views({ origin = ORIGIN } = {}) {
  const instructions = essentials();
  const base = { api: PANEL_API, version: version(), tools: panelTools() };
  // A watches its own load (./view/reach.js): a host that keeps it from the site gets the offline copy instead
  const reach = `<script>\n${fs.readFileSync(path.join(here, 'view/reach.js'), 'utf8').replace('__ORIGIN__', JSON.stringify(origin))}</script>\n`;
  const site = shell(Object.assign({ variant: 'site' }, base),
    `<script type="module">import(${JSON.stringify(`${origin}/connector/view/panel.js`)}).then((m) => { CLOADM_REACH.loaded(); return m.start(); }, (e) => CLOADM_REACH.importFailed(e)).catch((e) => startFailed(e.message));</script>`, reach);
  const { code, modules } = fold(path.join(here, 'view/panel.js'), { tail: '__ENTRY__.start().catch((e) => startFailed(e.message));\n' });
  const inline = shell(Object.assign({ variant: 'inline', programs: programs() }, base), `<script type="module">\n${code}</script>`);
  return { site, inline, modules, version: base.version, tools: base.tools, instructions, essentialsHash: essentialsHash(instructions) };
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
  fs.writeFileSync(out, `// generated by connector/build.js; do not edit\nexport default ${JSON.stringify({ site: v.site, inline: v.inline, version: v.version, instructions: v.instructions, essentialsHash: v.essentialsHash })};\n`);
  const { gzipSync } = await import('node:zlib');
  const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`site view ${kb(v.site.length)}; inline view ${kb(v.inline.length)} (${v.modules} modules, gzip ${kb(gzipSync(v.inline).length)}); version ${v.version}; connector essentials (skills/cloadm/SKILL.md) sha256:${v.essentialsHash}, ${v.instructions.length} characters`);
}
