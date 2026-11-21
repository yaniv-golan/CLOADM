// Builds the side-panel connector's two views for the Worker (connector/worker/), with no dependencies and no build
// step anywhere else in the repository:
//   node connector/build.js          -> connector/worker/src/views.gen.js (git-ignored; wrangler's [build] runs this)
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './fold.js';
import { PANEL_API, PROGRAM_FILES, panelToolbox } from './view/tools.js';
import { Session } from '../js/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
export const ORIGIN = 'https://cloadm.dev';

// CHANGELOG.md's "Next version" (the plugin's and the extension's version; tests/plugin.test.js keeps them in step)
export function version() {
  const log = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const m = /^Next version: (\S+?)\.? /m.exec(log) || /^Next version: (\S+)$/m.exec(log);
  if (!m) throw new Error('CHANGELOG.md: no "Next version:" line');
  return m[1];
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

function shell(cfg, module) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CLOADM</title>
<style>html,body{margin:0;background:#0b0d0c;color:#cfd8cf;font:13px system-ui}#bar{display:flex;flex-wrap:wrap;gap:6px;padding:6px;align-items:center}
button,label.btn{font:inherit;background:#1a1f1c;color:inherit;border:1px solid #3a443d;border-radius:6px;padding:4px 10px;cursor:pointer}
#screen{display:block;width:100%;max-width:640px;aspect-ratio:4/3;margin:0 auto;image-rendering:pixelated;background:#000;outline:none}
#screen:focus{box-shadow:0 0 0 2px #4c4}#st,#msg{padding:2px 8px;font:12px ui-monospace,monospace;color:#9aa59c;word-break:break-word}</style></head><body>
<div id="bar"><button id="big">Open in side panel</button><button id="liza">LIZA</button><button id="reset">Reset</button>
<label class="btn">Add ROMs…<input id="rom" type="file" multiple hidden></label><span>click the screen, then type</span></div>
<canvas id="screen" tabindex="0" width="320" height="240"></canvas>
<div id="msg"></div><div id="st">loading (${cfg.variant})…</div>
<script>globalThis.CLOADM_VIEW = ${scriptJson(cfg)};</script>
<script>
${fs.readFileSync(path.join(here, 'view/bridge.js'), 'utf8')}</script>
<script>addEventListener('error', (e) => { const why = e.message || (e.target && (e.target.src || e.target.href)) || String(e); document.getElementById('st').textContent = 'error: ' + why; CLOADM_BRIDGE.fail(why); }, true);
addEventListener('unhandledrejection', (e) => { const why = String((e.reason && e.reason.message) || e.reason); document.getElementById('st').textContent = 'error: ' + why; CLOADM_BRIDGE.fail(why); });</script>
${module}
</body></html>`;
}

export function views({ origin = ORIGIN } = {}) {
  const base = { api: PANEL_API, version: version(), tools: panelTools() };
  const site = shell(Object.assign({ variant: 'site' }, base),
    `<script type="module">import(${JSON.stringify(`${origin}/connector/view/panel.js`)}).then((m) => m.start()).catch((e) => { document.getElementById('st').textContent = 'error: ' + e.message; CLOADM_BRIDGE.fail(e.message); });</script>`);
  const { code, modules } = fold(path.join(here, 'view/panel.js'), { tail: '__ENTRY__.start().catch((e) => { document.getElementById(\'st\').textContent = \'error: \' + e.message; CLOADM_BRIDGE.fail(e.message); });\n' });
  const inline = shell(Object.assign({ variant: 'inline', programs: programs() }, base), `<script type="module">\n${code}</script>`);
  return { site, inline, modules, version: base.version, tools: base.tools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = views();
  const out = path.join(here, 'worker/src/views.gen.js');
  fs.writeFileSync(out, `// generated by connector/build.js; do not edit\nexport default ${JSON.stringify({ site: v.site, inline: v.inline, version: v.version })};\n`);
  const { gzipSync } = await import('node:zlib');
  const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`site view ${kb(v.site.length)}; inline view ${kb(v.inline.length)} (${v.modules} modules, gzip ${kb(gzipSync(v.inline).length)}); version ${v.version}`);
}
