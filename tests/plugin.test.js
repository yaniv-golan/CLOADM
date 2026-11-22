// The distribution manifests: the Claude Code plugin (.claude-plugin/plugin.json), the marketplace this repository is
// (.claude-plugin/marketplace.json) and the Claude Desktop extension (mcpb/manifest.json, packed by
// .github/workflows/release.yml). None of them is read by anything in this repository, so this suite is what keeps
// them true: valid JSON; one version, CHANGELOG.md's "Next version", in all three; every path they name resolves;
// no ${...} placeholder but the ones each host defines; the extension's tool list is the server's; and the server
// starts, and answers tools/list, when launched exactly as each manifest launches it.
// Sources: https://code.claude.com/docs/en/plugins-reference (plugin.json, ${CLAUDE_PLUGIN_ROOT}),
// https://code.claude.com/docs/en/plugin-marketplaces (marketplace.json, source "./"),
// https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md (manifest_version 0.3, ${__dirname},
// ${user_config.KEY}, user_config types).
// Run: node tests/plugin.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const rel = (...p) => path.join(ROOT, ...p);

function readJson(file) {
  try { return { json: JSON.parse(fs.readFileSync(rel(file), 'utf8')) }; } catch (e) { return { error: e.message }; }
}
const files = { plugin: '.claude-plugin/plugin.json', market: '.claude-plugin/marketplace.json', mcpb: 'mcpb/manifest.json' };
const J = {};
for (const [k, f] of Object.entries(files)) {
  const r = readJson(f);
  check(`${f} is valid JSON`, !r.error, r.error || '');
  J[k] = r.json || {};
}

// ---------------- one version ----------------
// CHANGELOG.md says, under [Unreleased], "Next version: X": the one place a maintainer changes it.
const changelog = fs.readFileSync(rel('CHANGELOG.md'), 'utf8');
const unreleased = changelog.split(/^### \d/m)[0];
const nextMatch = /^Next version: (\S+?)\.? /m.exec(unreleased) || /^Next version: (\S+)$/m.exec(unreleased);
const NEXT = nextMatch && nextMatch[1];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
check('CHANGELOG.md [Unreleased] names the next version, as semver', !!NEXT && SEMVER.test(NEXT), String(NEXT));

// semver precedence (https://semver.org/#spec-item-11), enough for x.y.z and x.y.z-pre
function cmp(a, b) {
  const A = SEMVER.exec(a), B = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (+A[i] !== +B[i]) return +A[i] - +B[i];
  if (!A[4] || !B[4]) return (A[4] ? -1 : 0) - (B[4] ? -1 : 0);
  return A[4] < B[4] ? -1 : A[4] > B[4] ? 1 : 0;
}
check('semver order: 0.1.7-pre > 0.1.6-pre > 0.1.6-alpha, 0.1.7 > 0.1.7-pre, 0.2.0 > 0.1.10',
  cmp('0.1.7-pre', '0.1.6-pre') > 0 && cmp('0.1.6-pre', '0.1.6-alpha') > 0 && cmp('0.1.7', '0.1.7-pre') > 0 && cmp('0.2.0', '0.1.10') > 0 && cmp('1.0.0', '1.0.0') === 0);
// the newest released heading ("### 0.1.6-pre"); the next version is never older than it. "Newest" is the greatest
// by SEMVER, not the first in the file: headings are written newest first, but a section inserted out of order (or a
// release cut in a hurry) must not make a guard read as satisfied by whichever heading happens to come first.
const headingsOf = (text) => [...text.matchAll(/^### (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/gm)].map((m) => m[1]);
const newestOf = (heads) => heads.reduce((a, b) => (a === undefined ? b : (cmp(b, a) > 0 ? b : a)), undefined);
const headings = headingsOf(changelog);
const newest = newestOf(headings);
check('CHANGELOG.md has release headings to compare with', headings.length > 0, headings.slice(0, 3).join(', '));
check('the next version is not older than the newest release in CHANGELOG.md', !!newest && !!NEXT && SEMVER.test(NEXT) && cmp(NEXT, newest) >= 0, `${NEXT} vs ${newest}`);
// THE CHECK ABOVE IS NOT VACUOUS ONLY IF "newest" IS NOT "first": exercise the REAL newestOf() on a list whose
// greatest is not first, so a revert to first-match would be caught here rather than by a copy of the reduce.
{
  const outOfOrder = headingsOf('### 0.1.8-pre\n### 0.2.0\n### 0.1.7-pre\n');
  check('...and newestOf() takes the greatest by semver, not the first heading in the file',
    outOfOrder[0] !== '0.2.0' && newestOf(outOfOrder) === '0.2.0', `first=${outOfOrder[0]} newest=${newestOf(outOfOrder)}`);
}

check('plugin.json has the next version', J.plugin.version === NEXT, `${J.plugin.version} vs ${NEXT}`);
check('mcpb/manifest.json has the next version', J.mcpb.version === NEXT, `${J.mcpb.version} vs ${NEXT}`);
// The marketplace entry leaves the version to plugin.json, which takes precedence (and `claude plugin validate`
// warns when both set it); any version the marketplace does give must be the same one.
const marketVersions = [];
JSON.stringify(J.market, (k, v) => { if (k === 'version') marketVersions.push(v); return v; });
check('marketplace.json gives no version that differs', marketVersions.every((v) => v === NEXT), marketVersions.join(', '));

// ---------------- names and paths ----------------
check('plugin.json: name "cloadm"', J.plugin.name === 'cloadm');
check('marketplace.json: name "cloadm-marketplace", an owner, one plugin "cloadm" at "./" with a description',
  J.market.name === 'cloadm-marketplace' && J.market.owner && J.market.owner.name && Array.isArray(J.market.plugins) &&
  J.market.plugins.length === 1 && J.market.plugins[0].name === 'cloadm' && J.market.plugins[0].source === './' && !!J.market.plugins[0].description);
for (const p of J.market.plugins || []) {
  const dir = path.resolve(ROOT, p.source), man = readJson(path.relative(ROOT, path.join(dir, '.claude-plugin', 'plugin.json')));
  check(`marketplace source ${p.source} is inside the repository and holds the plugin "${p.name}"`,
    (dir === ROOT || dir.startsWith(ROOT + path.sep)) && !man.error && man.json.name === p.name);
}

const server = (J.plugin.mcpServers || {}).cloadm || {};
check('plugin.json: mcpServers.cloadm is node cli/cloadm.js --mcp from the plugin root',
  server.command === 'node' && JSON.stringify(server.args) === JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/cli/cloadm.js', '--mcp']), JSON.stringify(server));
const pluginRoot = (s) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ROOT);
check('plugin.json: the server script resolves', fs.existsSync(pluginRoot(server.args[0])));
check('plugin.json: the icon resolves', !J.plugin.icon || (J.plugin.icon.startsWith('./') && fs.existsSync(rel(J.plugin.icon))), J.plugin.icon);

check('mcpb: manifest_version 0.3, a node server whose entry point is cli/cloadm.js',
  J.mcpb.manifest_version === '0.3' && J.mcpb.server && J.mcpb.server.type === 'node' && J.mcpb.server.entry_point === 'cli/cloadm.js');
const mc = (J.mcpb.server && J.mcpb.server.mcp_config) || {};
check('mcpb: the command runs the entry point with --mcp', mc.command === 'node' && mc.args && mc.args[0] === '${__dirname}/' + J.mcpb.server.entry_point && mc.args[1] === '--mcp');
for (const f of [J.mcpb.server && J.mcpb.server.entry_point, J.mcpb.icon].filter(Boolean)) check(`mcpb: ${f} resolves (staged at the bundle root as in the repository)`, fs.existsSync(rel(f)));
// the release stages exactly these into the bundle; what the manifest names must be among them
const release = fs.readFileSync(rel('.github/workflows/release.yml'), 'utf8');
const staged = ((/git archive HEAD ([^|]+)\|/.exec(release) || [])[1] || '').trim().split(/\s+/);
check('release.yml stages cli, js, examples and the manifest\'s icon into the bundle',
  ['cli', 'js', 'examples'].every((d) => staged.includes(d)) && staged.includes(J.mcpb.icon) && /cp mcpb\/manifest\.json stage\/manifest\.json/.test(release), staged.join(' '));
check('release.yml runs on tags v* only (plus a hand-started dry run), and checks the tag against the manifests',
  /on:\s*\n\s*push:\s*\n\s*tags: \['v\*'\]/.test(release) && !/branches:/.test(release)
  && /workflow_dispatch:/.test(release) && /test "\$have" = "\$v"/.test(release));

const uc = J.mcpb.user_config || {};
check('mcpb: user_config has the media folder (directory, required) and the ROM folder (directory, optional)',
  uc.media_root && uc.media_root.type === 'directory' && uc.media_root.required === true &&
  uc.roms && uc.roms.type === 'directory' && uc.roms.required === false && Object.keys(uc).length === 2);
check('mcpb: both are passed as arguments', mc.args && mc.args.includes('--media-root=${user_config.media_root}') && mc.args.includes('--roms=${user_config.roms}'), JSON.stringify(mc.args));

// ---------------- placeholders ----------------
function placeholders(obj) {
  const out = [];
  JSON.stringify(obj, (k, v) => { if (typeof v === 'string') for (const m of v.matchAll(/\$\{([^}]*)\}/g)) out.push(m[1]); return v; });
  return out;
}
const pp = placeholders(J.plugin).concat(placeholders(J.market));
check('plugin.json and marketplace.json: no placeholder but ${CLAUDE_PLUGIN_ROOT}', pp.every((p) => p === 'CLAUDE_PLUGIN_ROOT'), pp.join(', '));
const mp = placeholders(J.mcpb);
check('mcpb: no placeholder but ${__dirname} and ${user_config.<a declared key>}',
  mp.every((p) => p === '__dirname' || (/^user_config\.(\w+)$/.test(p) && Object.hasOwn(uc, p.slice(12)))), mp.join(', '));
check('no placeholder is left unclosed', !/\$\{[^}]*$/m.test(JSON.stringify([J.plugin, J.market, J.mcpb])));

// ---------------- the executable ----------------
// Cowork and claude.ai refuse a plugin with a top-level bin/ (https://code.claude.com/docs/en/plugins-reference,
// "Standard layout"; https://claude.com/docs/plugins/platform-support), and this plugin's root is the repository.
check('no top-level bin/ in the plugin root (Cowork and claude.ai refuse a plugin that has one)', !fs.existsSync(rel('bin')));
const cliText = fs.readFileSync(rel('cli/cloadm.js'), 'utf8');
check('cli/cloadm.js starts with a node shebang', cliText.startsWith('#!/usr/bin/env node\n'));
check('cli/cloadm.js is executable (git mode 100755)', process.platform === 'win32' || (fs.statSync(rel('cli/cloadm.js')).mode & 0o111) === 0o111,
  (fs.statSync(rel('cli/cloadm.js')).mode & 0o777).toString(8));

// ---------------- the tools ----------------
const M = require('../cli/mcp.js'), T = require('../js/mcp/tools.js');
const serverTools = T.createToolbox(M.nodeHost({ mediaRoot: null, roms: [], png: () => null }), {}).tools();
const listed = (J.mcpb.tools || []).map((t) => t.name);
check('mcpb: the tool list is the server\'s, in its order', JSON.stringify(listed) === JSON.stringify(serverTools.map((t) => t.name)),
  `manifest ${listed.join(',')} | server ${serverTools.map((t) => t.name).join(',')}`);
check('mcpb: every listed tool has a description', (J.mcpb.tools || []).every((t) => typeof t.description === 'string' && t.description.length > 0));
check('mcpb: tools_generated is false (the list is static)', J.mcpb.tools_generated === false);

// ---------------- the server starts as each manifest starts it ----------------
// Spawn the command with the host's substitutions, do the initialize handshake and tools/list, close stdin.
// HOME (and APPDATA) point at an empty directory unless a case gives one with a config file, so the real user's
// ~/.config/cloadm/config.json never takes part.
function launch(command, args, home) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') });
    const child = spawn(command === 'node' ? process.execPath : command, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (d) => { out += d; if (out.split('\n').filter(Boolean).length >= 2) child.stdin.end(); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const msgs = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
      resolve({ code, err, msgs });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}
const answered = (r) => r.msgs.length >= 2 && r.msgs[0] && r.msgs[0].id === 1 && r.msgs[0].result && r.msgs[0].result.serverInfo.name === 'cloadm' &&
  r.msgs[1] && r.msgs[1].id === 2 && r.msgs[1].result && r.msgs[1].result.tools.length === serverTools.length;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-plugin-'));
  try {
    const empty = path.join(TMP, 'home-empty'), media = path.join(TMP, 'media'), roms = path.join(TMP, 'roms');
    for (const d of [empty, media, roms]) fs.mkdirSync(d);
    {
      const r = await launch(server.command, server.args.map(pluginRoot), empty);
      check('plugin.json\'s server starts with no configuration, lists its tools, and takes ~/CLOADM as its media folder without making it',
        answered(r) && r.err.includes(`media root ${path.join(empty, 'CLOADM')} (default)`) && !fs.existsSync(path.join(empty, 'CLOADM')), `exit ${r.code} ${r.err.trim()}`);
    }
    {
      // the plugin passes no paths; the config file gives them (docs/mcp.md, "Your ROMs and media folder")
      const home = path.join(TMP, 'home-config'), dir = process.platform === 'win32' ? path.join(home, 'AppData', 'cloadm') : path.join(home, '.config', 'cloadm');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mediaRoot: media, roms: [roms] }));
      const r = await launch(server.command, server.args.map(pluginRoot), home);
      check('plugin.json\'s server takes the media root from the config file', answered(r) && r.err.includes(fs.realpathSync(media)), `exit ${r.code} ${r.err.trim()}`);
    }
    const sub = (cfg) => mc.args.map((a) => a.replace(/\$\{__dirname\}/g, ROOT).replace(/\$\{user_config\.(\w+)\}/g, (m, k) => (k in cfg ? cfg[k] : m)));
    {
      const r = await launch(mc.command, sub({ media_root: media, roms }), empty);
      check('mcpb\'s server starts with a media folder and a ROM folder, and lists its tools', answered(r) && r.err.includes(fs.realpathSync(media)), `exit ${r.code} ${r.err.trim()}`);
    }
    {
      const r = await launch(mc.command, sub({ media_root: media, roms: '' }), empty);
      check('mcpb\'s server starts when the optional ROM folder is substituted empty', answered(r), `exit ${r.code} ${r.err.trim()}`);
    }
    {
      const r = await launch(mc.command, sub({ media_root: media }), empty);
      check('mcpb\'s server starts when the ROM folder placeholder is left unfilled', answered(r), `exit ${r.code} ${r.err.trim()}`);
    }
    {
      const r = await launch(mc.command, sub({ media_root: path.join(TMP, 'missing'), roms }), empty);
      check('mcpb\'s server refuses a media folder that does not exist (exit 3, on stderr)', r.code === 3 && /media root/.test(r.err) && r.msgs.length === 0, `exit ${r.code} ${r.err.trim()}`);
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(fail ? `${fail} FAILED` : `${n}/${n} plugin manifest checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
