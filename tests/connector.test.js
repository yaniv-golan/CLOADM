// The side-panel connector (connector/), without a browser:
//  * the Worker (connector/worker/src/server.js) over Streamable HTTP as Claude calls it: initialize, tools/list (two
//    tools, each with its ui:// view), tools/call, resources/list and resources/read (the MCP Apps MIME type, the CSP:
//    variant A declares https://cloadm.dev only, B nothing), notifications (202), GET (405), bad bodies; it writes no
//    console output; wrangler.toml holds no secret, no account and keeps logs off;
//  * the views (connector/build.js): A fetches one module, from cloadm.dev; B fetches nothing and carries the bundled
//    programs; both carry the tool list and PANEL_API; the version is the checkout's `git describe`; the build refuses
//    a site whose PANEL_API differs (checkSite);
//  * the folded core (connector/fold.js) runs LIZA identically to the plain modules (screen, frame count, every pixel),
//    and the folded panel toolbox lists the same tools;
//  * the panel's tools (connector/view/tools.js): the local server's names and schemas, byte for byte; the file tools
//    left out; results over 100,000 characters refused; every bundled program file a model can ask for is carried;
//  * the bridge (connector/view/bridge.js) in a vm, playing the host: ui/initialize is sent as the script runs, before
//    the emulator exists; tools/list is answered at once; an early call waits for the emulator; list_changed follows
//    attach; a mismatched PANEL_API is out-of-step, a failed start not-started; a cancelled call gets no reply; the
//    host context keys it keeps (the phone's insets among them); size-changed; the last call in Details;
//  * the view's sizing, insets, touch test and the on-screen keys' codes (connector/view/ui.js, js/ui/touch-layout.js).
// The browser check's `connector` group runs both views in Chromium under the spec's CSP (tools/connector-check.js).
// Run: node tests/connector.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;

(async () => {
  const build = await imp('connector/build.js');
  const { createServer, ORIGIN, MIME } = await imp('connector/worker/src/server.js');
  const panel = await imp('connector/view/tools.js');
  const T = await imp('js/mcp/tools.js');
  const { Session } = await imp('js/session.js');
  const { profiles } = await imp('js/machines/profiles.js');
  const { GAMES } = await imp('js/session.js');
  const views = build.views();

  // ---------------- the Machine menu's groups ----------------
  // by lineage, not keyboard: the Dragon 200-E (its own Spanish keyboard) is a Dragon, and every model is in one group
  const groupsOf = (id) => panel.MACHINE_GROUPS.filter(([, has]) => has(profiles[id])).map(([g]) => g);
  check('Machine menu: every model is in exactly one group', Object.keys(profiles).every((id) => groupsOf(id).length === 1),
    J(Object.keys(profiles).filter((id) => groupsOf(id).length !== 1)));
  check('Machine menu: the Dragon 200-E is under Dragon, with the Dragon 64', J(groupsOf('dragon200e')) === J(['Dragon']) && J(groupsOf('dragon64')) === J(['Dragon']), J(groupsOf('dragon200e')));
  check('Machine menu: the CoCos, clones and MC-10s are in their own groups', J(['coco', 'cp400', 'coco3', 'mc10', 'alice'].map((id) => groupsOf(id)[0])) === J(['Color Computer', 'Color Computer', 'Color Computer', 'MC-10', 'MC-10']));

  // ---------------- the Worker ----------------
  const logged = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => logged.push(a); }
  const worker = createServer(views);
  const post = async (body, raw) => {
    const r = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp', { method: 'POST', body: raw != null ? raw : J(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }));
    const t = await r.text();
    return { status: r.status, type: r.headers.get('content-type'), body: t ? JSON.parse(t) : null };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const initOld = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const calls = await Promise.all(['open_emulator', 'open_emulator_inline'].map((name) => post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })));
  const unknown = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'type_text', arguments: {} } });
  const rlist = await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  const read = async (uri) => (await post({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri } })).body;
  const A = (await read('ui://cloadm/panel.html')).result.contents[0], B = (await read('ui://cloadm/inline.html')).result.contents[0];
  const noRes = await read('ui://cloadm/nope.html');
  const batch = await post([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  // a batch of reads of the 1 MiB view (57 KB of request asking for about 600 MiB of reply) is refused unread
  const bomb = await post(Array.from({ length: 600 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'resources/read', params: { uri: 'ui://cloadm/inline.html' } })));
  // the body limit is in bytes, not characters: 30,000 three-byte characters are 90,000 bytes
  const wide = await post(null, J({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: '\u20ac'.repeat(30000) } }));
  const lied = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-length': '999999' } }));
  const get = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp'));
  const other = await worker.fetch(new Request('https://mcp.cloadm.dev/'));
  const parse = await post(null, '{nope');
  const invalid = await post({ id: 1, method: 'ping' });
  const big = await post(null, J({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70000) } }));
  const method = await post({ jsonrpc: '2.0', id: 8, method: 'prompts/list' });
  for (const k of Object.keys(saved)) console[k] = saved[k];

  // git as the build runs it; null where it cannot answer (no git binary, or not a checkout: a source archive)
  const git = (args) => {
    try { return require('child_process').execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; }
  };
  const inCheckout = git(['rev-parse', 'HEAD']) !== null;
  check('initialize: the client\'s version when the Worker speaks it, else the newest; the MCP Apps extension; the release version',
    init.body.result.protocolVersion === '2025-06-18' && initOld.body.result.protocolVersion === '2025-11-25'
    && J(init.body.result.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes) === J([MIME])
    && init.body.result.serverInfo.version === build.version() && (build.version() !== 'unknown') === inCheckout && /next message/.test(init.body.result.instructions), J(init.body));
  // the connector's instructions have ONE source: the "connector essentials" section of the skill (build.js copies it)
  {
    const skill = fs.readFileSync(path.join(ROOT, 'skills/cloadm/SKILL.md'), 'utf8');
    const m = /<!-- connector-essentials:start -->\n([\s\S]*?)\n<!-- connector-essentials:end -->/.exec(skill);
    const want = m && m[1].trim();
    const sha = require('crypto').createHash('sha256').update(want || '').digest('hex').slice(0, 12);
    check('instructions: the Worker serves exactly the skill\'s connector essentials section, in every protocol version', !!want && want.length > 500
      && init.body.result.instructions === want && initOld.body.result.instructions === want && views.instructions === want, J(init.body.result.instructions).slice(0, 120));
    check('instructions: the first line names the route, "You are driving CLOADM in the person\'s side panel."', init.body.result.instructions.split('\n')[0] === 'You are driving CLOADM in the person\'s side panel.', J(init.body.result.instructions.split('\n')[0]));
    check('instructions: the build\'s hash is the section\'s sha-256 (printed by node connector/build.js)', views.essentialsHash === sha && /^[0-9a-f]{12}$/.test(sha), `${views.essentialsHash} ${sha}`);
    const src = fs.readFileSync(path.join(ROOT, 'connector/worker/src/server.js'), 'utf8');
    check('instructions: the Worker holds no copy of its own (no INSTRUCTIONS constant, no instructions literal), it uses the views\'', !/\bINSTRUCTIONS\b/.test(src) && !/instructions:\s*['"`]/.test(src) && /instructions: views\.instructions/.test(src));
    const gen = path.join(ROOT, 'connector/worker/src/views.gen.js');
    if (fs.existsSync(gen)) {
      const g = (await imp('connector/worker/src/views.gen.js')).default;
      check('instructions: the generated views.gen.js (the last build) carries the skill\'s section now: rebuild (node connector/build.js) and redeploy the Worker after editing it',
        g.instructions === want && g.essentialsHash === sha, `${g.essentialsHash} vs ${sha}`);
    } else console.log('ok   instructions: no generated views.gen.js here (wrangler\'s [build] makes it); the views() check above covers the build');
    const tomlText = fs.readFileSync(path.join(ROOT, 'connector/worker/wrangler.toml'), 'utf8');
    check('instructions: wrangler dev rebuilds when the skill changes (watch_dir holds ../../skills/cloadm)', /watch_dir\s*=\s*\[[^\]]*"\.\.\/\.\.\/skills\/cloadm"/.test(tomlText));
    let refused = null; try { createServer({ site: 'a', inline: 'b', version: 'x' }); } catch (e) { refused = e; }
    check('instructions: a Worker built from views without instructions refuses to start', !!refused && /instructions/.test(refused.message));
  }
  check('a notification gets 202 and no body', notif.status === 202 && notif.body === null);
  check('a batch (a JSON array) is refused with -32600, also one of 600 reads of the 1 MiB view (nothing is built)', batch.status === 400 && batch.body.error.code === -32600 && /batches/.test(batch.body.error.message)
    && bomb.status === 400 && bomb.body.error.code === -32600 && J(bomb.body).length < 200, J(batch.body));
  check('the 64 KiB limit counts bytes (90,000 bytes of 30,000 characters: 413), and a Content-Length over it is refused before reading', wide.status === 413 && lied.status === 413, `${wide.status} ${lied.status}`);
  const tools = list.body.result.tools;
  check('tools/list: the two server tools, each opening its view, no arguments, read-only',
    J(tools.map((t) => [t.name, t._meta.ui.resourceUri])) === J([['open_emulator', 'ui://cloadm/panel.html'], ['open_emulator_inline', 'ui://cloadm/inline.html']])
    && tools.every((t) => t.inputSchema.type === 'object' && J(t.inputSchema.properties) === '{}' && t.annotations.readOnlyHint), J(tools).slice(0, 300));
  // what people see: the server is "CLOADM side panel" (cloadm-panel, the plugin's id for it); the tools' titles are
  // plain verbs; Open CLOADM comes first, the offline copy only after a blocked load
  check('names: serverInfo is cloadm-panel, "CLOADM side panel"', init.body.result.serverInfo.name === 'cloadm-panel' && init.body.result.serverInfo.title === 'CLOADM side panel', J(init.body.result.serverInfo));
  check('names: "Open CLOADM" and "Open CLOADM (offline copy)", each with its description, the title in annotations too',
    J(tools.map((t) => [t.title, t.description, t.annotations.title])) === J([
      ['Open CLOADM', 'Opens the CLOADM emulator in a panel beside the chat. Use this first.', 'Open CLOADM'],
      ['Open CLOADM (offline copy)', 'Only if Open CLOADM showed a blank or blocked panel: opens a larger copy that doesn\'t need to reach cloadm.dev.', 'Open CLOADM (offline copy)']]), J(tools.map((t) => t.title)));
  check('names: Open CLOADM\'s answer says to open the offline copy without asking if the panel is blank or blocked; the offline copy\'s does not',
    /blocked, open the offline copy \(open_emulator_inline\) without asking/.test(calls[0].body.result.content[0].text) && !/open_emulator_inline/.test(calls[1].body.result.content[0].text), calls[0].body.result.content[0].text.slice(-200));
  {
    // every tool of both servers (the stdio server's toolbox, the panel's) has a title, a plain verb with no prefix
    const all = [...T.createToolbox({ roms: () => [] }, {}).tools(), ...build.panelTools(), ...tools];
    const bad = all.filter((t) => !(typeof t.title === 'string' && /^[A-Z][a-z]/.test(t.title) && !/CLOADM:|^Claude|^cloadm|_/.test(t.title)));
    check('names: every tool of both servers has a title that starts with a verb, with no server prefix or tool name', all.length > 40 && !bad.length, J(bad.map((t) => [t.name, t.title])));
    check('names: the page tools read as people say them ("Type text", "Read the screen", "Read memory")',
      J(['type_text', 'screen_text', 'peek'].map((n) => build.panelTools().find((t) => t.name === n).title)) === J(['Type text', 'Read the screen', 'Read memory']));
  }
  check('tools/call: says the app tools come in the next message, on machine m1', calls.every((c) => /next message/.test(c.body.result.content[0].text) && /"m1"/.test(c.body.result.content[0].text)));
  check('tools/call: the app tools are not server tools', unknown.body.error.code === -32602);
  check('resources: both views, as MCP Apps HTML', J(rlist.body.result.resources.map((r) => [r.uri, r.mimeType])) === J([['ui://cloadm/panel.html', MIME], ['ui://cloadm/inline.html', MIME]])
    && A.mimeType === MIME && B.mimeType === MIME && A.text === views.site && B.text === views.inline && noRes.error.code === -32602);
  check('CSP: variant A declares https://cloadm.dev and nothing else; B declares none', ORIGIN === 'https://cloadm.dev'
    && J(A._meta.ui.csp) === J({ resourceDomains: ['https://cloadm.dev'], connectDomains: ['https://cloadm.dev'] }) && B._meta.ui.csp === undefined, J([A._meta, B._meta]));
  check('HTTP: GET 405, other paths 404, a parse error 400, a non-JSON-RPC body 400, a body over 64 KiB 413, an unknown method -32601',
    get.status === 405 && get.headers.get('allow') === 'POST' && other.status === 404 && parse.status === 400 && parse.body.error.code === -32700
    && invalid.status === 400 && big.status === 413 && method.body.error.code === -32601);
  check('the Worker writes nothing to the console (no request is logged)', logged.length === 0, J(logged).slice(0, 200));
  const workerSrc = ['server.js', 'index.js'].map((f) => fs.readFileSync(path.join(ROOT, 'connector/worker/src', f), 'utf8')).join('\n');
  const toml = fs.readFileSync(path.join(ROOT, 'connector/worker/wrangler.toml'), 'utf8');
  check('no logging, no storage, no secret: no console in the source; wrangler.toml has logs off and no account, vars, KV or secrets',
    !/console\.|caches\.|\.put\(/.test(workerSrc) && /\[observability\]\s*\nenabled = false/.test(toml) && !/account_id|\[vars\]|kv_namespaces|secret|token/i.test(toml.replace(/^#.*$/gm, ''))
    && /command = "node \.\.\/build\.js"/.test(toml), toml);
  check('the generated views are not committed', fs.readFileSync(path.join(ROOT, 'connector/worker/.gitignore'), 'utf8').split('\n').includes('src/views.gen.js'));

  // ---------------- the views ----------------
  const cfgOf = (html) => JSON.parse(/<script>globalThis\.CLOADM_VIEW = (.*);<\/script>/.exec(html)[1]);
  const cfgA = cfgOf(views.site), cfgB = cfgOf(views.inline);
  const fetched = (html) => [...html.matchAll(/\bimport\s*\(\s*("[^"]*"|'[^']*')/g)].map((m) => JSON.parse(m[1].replace(/^'|'$/g, '"')));
  check('A: the only thing it fetches is panel.js from cloadm.dev (which brings js/ from beside it); no src or href',
    J(fetched(views.site)) === J(['https://cloadm.dev/connector/view/panel.js']) && !/\s(src|href)\s*=/i.test(views.site.replace(/<script>[\s\S]*?<\/script>/g, '')), J(fetched(views.site)));
  check('B: nothing to fetch (no import, no src); the bundled programs inline', !/\bfrom\s*'(\.|https?:)|\bimport\s*\(|<script[^>]*\bsrc=/.test(views.inline)
    && J(Object.keys(cfgB.programs)) === J(panel.PROGRAM_FILES) && panel.PROGRAM_FILES.every((f) => cfgB.programs[f] === fs.readFileSync(path.join(ROOT, 'examples', f)).toString('base64')));
  check('both: the bridge before the emulator, PANEL_API and the version in CLOADM_VIEW, the tool list as the panel lists it',
    [views.site, views.inline].every((h) => h.indexOf('CLOADM_BRIDGE = {') < h.indexOf('<script type="module">')) && cfgA.api === panel.PANEL_API && cfgB.api === panel.PANEL_API
    && cfgA.version === build.version() && J(cfgA.tools) === J(build.panelTools()) && J(cfgB.tools) === J(cfgA.tools) && cfgA.programs === undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const describedRaw = git(['describe', '--tags', '--always', '--dirty']);
  if (describedRaw === null) {
    // without git the build cannot know what it is, and says so rather than borrowing the released number
    check('the version without git is "unknown", not the released number in CHANGELOG.md or the manifests',
      build.version() === 'unknown' && build.version() !== manifest.version, `${build.version()} ${manifest.version}`);
  } else {
    const described = describedRaw.trim().replace(/^v/, '');
    const tags = (git(['tag', '--points-at', 'HEAD']) || '').split('\n');
    check('the version is the build\'s (git describe), not the released number in CHANGELOG.md or the manifests', build.version() === described
      && (tags.includes(`v${manifest.version}`) || build.version() !== manifest.version), `${build.version()} ${described} ${manifest.version}`);
  }
  const site = (body) => async () => body;
  const same = await build.checkSite(site(`export const PANEL_API = ${panel.PANEL_API};`));
  const otherApi = await build.checkSite(site(`export const PANEL_API = ${panel.PANEL_API + 1};`));
  const missing = await build.checkSite(async () => { throw new Error('HTTP 404'); });
  const none = await build.checkSite(site('// not the panel'));
  check('build: the site check passes only when cloadm.dev serves the same PANEL_API (a release not yet on the site is refused)', same.ok && !otherApi.ok && /serves PANEL_API/.test(otherApi.why)
    && !missing.ok && /404/.test(missing.why) && !none.ok, J([otherApi, missing, none]));
  // the iOS app blocks a call that is not read-only, with no prompt, unless the connector is set to "Manually approve";
  // a blocked call never reaches the view (no tools/call, and tool-input/tool-result carry no call id), so Details says it
  for (const [n, h] of [['A', views.site], ['B', views.inline]]) {
    const det = (/<details id="details">([\s\S]*?)<\/details>/.exec(h) || [])[1] || '';
    check(`${n}: Details says that on the Claude iOS app the connector's Permission must be "Manually approve" for Claude to type and run; read-only tools work either way`,
      /<p class="approve">On the Claude iOS app, set the CLOADM connector's Permission to "Manually approve" so Claude can type into and run the machine; read-only tools work either way\.<\/p>/.test(det), det.slice(0, 300));
  }
  check('B is about 1 MiB (claude.ai has accepted a 909 KiB view)', views.inline.length < 1.25 * 1024 * 1024, `${views.inline.length}`);

  // ---------------- the folded core ----------------
  const { fold } = await imp('connector/fold.js');
  const loadFolded = async (entry, tail) => import('data:text/javascript;base64,' + Buffer.from(fold(path.resolve(ROOT, entry), { tail }).code).toString('base64'));
  const liza = fs.readFileSync(path.join(ROOT, 'examples/liza.bin'));
  async function run(S) {
    const s = new S({ welcomeMenu: false }); await s.ready();
    s.switchMachine('dragon64', undefined, { menu: false });
    s.runLiza(liza);
    s.runFrames(100);
    s.typeText('I AM HAPPY\n');
    s.runFrames(400);
    const f = s.shownMachine.render();
    return { text: s.screenText().join('\n'), frames: s.shownMachine.frameCount, pixels: Buffer.from(f.data).toString('base64') };
  }
  const folded = await run((await loadFolded('js/session.js', 'export const Session = __ENTRY__.Session;\n')).Session);
  const plain = await run(Session);
  check('fold: the folded emulator runs LIZA identically to the plain modules (screen, frames, every pixel)', /> I AM HAPPY/.test(plain.text) && J(folded) === J(plain), plain.text);
  // an entry that brings the panel toolbox and the Session class it checks for, from the same folded graph
  const entry = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cloadm-fold-')), 'entry.js');
  fs.writeFileSync(entry, `import { Session } from '${path.join(ROOT, 'js/session.js')}';\nimport { panelToolbox, PANEL_API } from '${path.join(ROOT, 'connector/view/tools.js')}';\nexport { Session, panelToolbox, PANEL_API };\n`);
  const fp = await loadFolded(entry, 'export const { Session, panelToolbox, PANEL_API } = __ENTRY__;\n');
  const fs2 = new fp.Session({ welcomeMenu: false });
  fs2.switchMachine('dragon64', undefined, { menu: false });
  check('fold: the folded panel toolbox is the plain one (PANEL_API, every tool and schema)', fp.PANEL_API === panel.PANEL_API && fp.Session !== Session
    && J(fp.panelToolbox(fs2, {}).tools()) === J(build.panelTools()));
  let refused = null;
  try { fold(path.join(ROOT, 'connector/fold.js')); } catch (e) { refused = e.message; }
  check('fold: a form it does not know fails loudly (node: imports are not relative files)', refused !== null, refused);

  // ---------------- the panel's tools ----------------
  const host = { roms: () => [], png: () => new Uint8Array(0), program: () => new Uint8Array(0), now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate),
    readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
  const local = Object.fromEntries(T.createToolbox(host).tools().map((t) => [t.name, t]));
  const offered = build.panelTools();
  check('panel tools: no ROM store in the panel, so add_roms and remove_roms are not offered (the toolbox would only refuse them)',
    !offered.some((t) => t.name === 'add_roms' || t.name === 'remove_roms') && !!local.add_roms && !!local.remove_roms, offered.map((t) => t.name).join(','));
  check('panel tools: the local server\'s names, schemas and annotations; the file tools and close_machine left out',
    offered.every((t) => t.name === 'boot' || J(t) === J(panel.compactTool(t.name === 'load' ? { ...local.load, description: local.load.description.replace(/ For playing or watching a machine with the person, prefer the CLOADM side-panel connector.*$/, '') } : local[t.name]))) && J(offered.map((t) => t.name)) === J(Object.keys(local).filter((k) => !panel.LEFT_OUT.includes(k)))
    && !/side-panel connector/.test(offered.find((t) => t.name === 'load').description) && /side-panel connector/.test(local.load.description)
    && panel.LEFT_OUT.every((k) => local[k]) && J(offered.find((t) => t.name === 'boot').inputSchema) === J(panel.compactTool(local.boot).inputSchema), offered.map((t) => t.name).join(','));
  const want = ['boot', 'switch_machine', 'type_text', 'press_keys', 'screen_text', 'screenshot', 'peek', 'find_bytes', 'disassemble', 'registers', 'step', 'run', 'run_frames', 'load', 'reset', 'power_cycle'];
  check('panel tools: everything the panel runs is offered', want.every((w) => offered.some((t) => t.name === w)) && offered.length <= 64, want.filter((w) => !offered.some((t) => t.name === w)).join(','));
  // The host drops a tool listing whose input schemas together run past 8 KB (claude.ai said so of this panel's: it was
  // 11.1 KB). The budget is under that with a margin; a longer description or one more parameter spends it, and the fix
  // is shorter wording, not a bigger number (docs/deploy-connector.md says how the schemas are kept short).
  {
    const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
    const SCHEMA_BUDGET = 7600, LIST_BUDGET = 28000, WORKER_BUDGET = 2000;
    const schemas = offered.reduce((n, t) => n + bytes(t.inputSchema), 0), whole = bytes(offered);
    check(`panel tools: the input schemas together are ${schemas} bytes, within the ${SCHEMA_BUDGET} budget (the host's limit is 8 KB)`, schemas <= SCHEMA_BUDGET, `${schemas} of ${SCHEMA_BUDGET}; the five largest: ${offered.map((t) => [t.name, bytes(t.inputSchema)]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, b]) => `${n} ${b}`).join(', ')}`);
    check(`panel tools: the whole tools/list the bridge answers from is ${whole} bytes, within ${LIST_BUDGET}`, whole <= LIST_BUDGET && J(views.tools) === J(offered), `${whole} of ${LIST_BUDGET}`);
    check('the Worker\'s own tools/list stays small', bytes(list.body.result.tools) <= WORKER_BUDGET, `${bytes(list.body.result.tools)} of ${WORKER_BUDGET}`);
    check('the local server\'s schemas are NOT the compact ones: full, over the host\'s 8 KB panel limit', Object.values(local).reduce((n, t) => n + bytes(t.inputSchema), 0) > 10000
      && Object.values(local).every((t) => t.inputSchema.additionalProperties === false && Array.isArray(t.inputSchema.required)), String(Object.values(local).reduce((n, t) => n + bytes(t.inputSchema), 0)));
  }
  // The compaction changes words and a few shapes, nothing a call depends on. Full and compact are compared STRUCTURALLY, for
  // every tool: the same property names and types, the same bounds, enums, defaults and required names, ignoring only
  // descriptions, additionalProperties: false and an empty required list; the two declared exceptions are an address
  // ({anyOf: [{integer, minimum, maximum}, {string, pattern}]} is {type: [integer, string]}, its range kept in the
  // description) and switch_machine's model, which names no enum (boot has it).
  {
    const NO_ENUM = ['switch_machine.model'];
    const skel = (n, path) => {
      if (Array.isArray(n)) return n.map((x) => skel(x, path));
      if (!n || typeof n !== 'object') return n;
      if ((Array.isArray(n.anyOf) && n.anyOf.length === 2 && n.anyOf[0].type === 'integer' && n.anyOf[1].type === 'string' && n.anyOf[1].pattern)
        || (J(n.type) === J(['integer', 'string']) && n.minimum === undefined)) return { address: true };
      const o = {};
      for (const [k, v] of Object.entries(n)) {
        if (k === 'description' || (k === 'additionalProperties' && v === false) || (k === 'required' && Array.isArray(v) && !v.length) || (k === 'enum' && NO_ENUM.includes(path))) continue;
        o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pn, pv]) => [pn, skel(pv, `${path}.${pn}`)])) : (k === 'items' || k === 'anyOf') ? skel(v, path) : v;
      }
      return o;
    };
    const differ = [], longer = [], noRange = [];
    for (const t of offered) {
      const f = local[t.name];
      if (J(skel(t.inputSchema, t.name)) !== J(skel(f.inputSchema, t.name))) differ.push(t.name);
      const walk = (a, b, at) => { if (!a || typeof a !== 'object') return; for (const [pn, pv] of Object.entries(a.properties || {})) {
        const fb = b.properties[pn]; if (typeof pv.description === 'string' && typeof fb.description === 'string' && pv.description.length > fb.description.length) longer.push(`${at}.${pn}`);
        if (Array.isArray(fb.anyOf) && fb.anyOf[1] && fb.anyOf[1].pattern && !pv.description.includes(`${fb.anyOf[0].minimum}-${fb.anyOf[0].maximum}`)) noRange.push(`${at}.${pn}`);
        walk(pv, fb, `${at}.${pn}`); } };
      walk(t.inputSchema, f.inputSchema, t.name);
    }
    check('compaction: every tool\'s compact schema has the full one\'s property names, types, bounds, enums and required names (descriptions and closing aside)', !differ.length, differ.join());
    check('compaction: no description gets longer, and an address\'s range stays in its description', !longer.length && !noRange.length, `${longer.join()} | ${noRange.join()}`);
    // wording the structural comparison cannot judge: a quantity keeps its unit word. Every unit word the full description
    // uses outside a quoted example is still in the compact one (frames, keys, bytes, characters, instructions, pixels ...)
    const UNIT = /\b(frames?|ms|keys?|bytes?|characters?|instructions?|pixels?|seconds?|rows?|lines?|KB)\b/gi;
    const unitsOf = (d) => new Set((d.replace(/"[^"]*"/g, '').match(UNIT) || []).map((u) => u.toLowerCase().replace(/s$/, '')));
    const lostUnit = [];
    const unitWalk = (c, f, at) => { for (const [pn, pv] of Object.entries(c.properties || {})) {
      const fb = f.properties[pn];
      if (typeof pv.description === 'string' && typeof fb.description === 'string') { const have = unitsOf(pv.description); for (const u of unitsOf(fb.description)) if (!have.has(u)) lostUnit.push(`${at}.${pn}: ${u}`); }
      unitWalk(pv, fb, `${at}.${pn}`); } };
    for (const t of offered) unitWalk(t.inputSchema, local[t.name].inputSchema, t.name);
    check('compaction: a quantity keeps its unit word (frames, keys, bytes, characters, instructions, pixels) wherever the full description had one, quoted examples aside', !lostUnit.length, lostUnit.join('; '));
    const rules = panel.compactionRules();
    check('compaction: every rewording rule found its text in the toolbox\'s schemas (none is stale)', rules.words.every((w) => rules.used.includes(w)) && rules.noEnum.every((w) => rules.used.includes(w)),
      `${rules.words.filter((w) => !rules.used.includes(w)).map((w) => w.replace('\u0000', ' <- ').slice(0, 60)).join(' | ')}`);
    check('compaction: it is deterministic and leaves the toolbox\'s own schemas as they were', J(offered) === J(build.panelTools()) && J(panel.compactTool(panel.compactTool(local.boot))) === J(panel.compactTool(local.boot)));
    const fresh = T.createToolbox(host).tools(), before = J(fresh);
    fresh.forEach((t) => panel.compactTool(t));
    check('compaction: it works on a copy: the toolbox\'s own schemas (shared between tools) are as they were after it', J(fresh) === before && fresh.some((t) => t.inputSchema.additionalProperties === false));
  }
  const s = new Session({ welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  const ptb = panel.panelToolbox(s, Object.assign({}, host, { program: (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f))) }));
  const b64 = (b) => Buffer.from(b).toString('base64');
  await ptb.call('load', { machine_id: 'm1', program: 'liza' }, { base64: b64 });
  await ptb.call('run_frames', { machine_id: 'm1', frames: 100 }, { base64: b64 });
  const st = await ptb.call('screen_text', { machine_id: 'm1' }, { base64: b64 });
  check('panel tools: screen text comes back wrapped as untrusted machine_output, as from the local server', !st.isError && st.structuredContent.untrusted === T.UNTRUSTED_NOTE
    && /LIZA/.test(st.structuredContent.machine_output.lines.join('\n')) && JSON.parse(st.content[0].text).untrusted === T.UNTRUSTED_NOTE, J(st).slice(0, 300));
  const info = await ptb.call('machine_info', { machine_id: 'm1' }, { base64: b64 });
  check('panel tools: machine_info reports the route, "panel" (the local server says "local")', !info.isError && info.structuredContent.route === 'panel' && info.structuredContent.model === 'Dragon 64', J(info.structuredContent));
  const path1 = await ptb.call('load', { machine_id: 'm1', path: 'game.bin' }, { base64: b64 });
  const tape = await ptb.call('insert_tape', { machine_id: 'm1', path: 'x.cas' }, { base64: b64 });
  check('panel tools: a file is refused with no-media-root, naming what works; a left-out tool says why', path1.isError && path1.structuredContent.error.code === 'no-media-root'
    && /side panel has no media folder/.test(path1.structuredContent.error.detail) && tape.isError && /no tool "insert_tape" in the side panel/.test(tape.structuredContent.error.detail), J([path1, tape]).slice(0, 400));
  const fake = (k) => Uint8Array.from({ length: 16384 }, (_, i) => (i * 13 + k) & 255);
  const before = await ptb.call('peek', { machine_id: 'm1', address: 0x3000, length: 2 }, { base64: b64 });
  s.addRoms([{ name: 'd64_1.rom', bytes: fake(1) }, { name: 'd64_2.rom', bytes: fake(2) }]);
  const romReads = await Promise.all([ptb.call('peek', { machine_id: 'm1', address: 0x8000, length: 16 }, { base64: b64 }), ptb.call('find_bytes', { machine_id: 'm1', pattern: '01 0E' }, { base64: b64 }), ptb.call('disassemble', { machine_id: 'm1', address: 0x8000 }, { base64: b64 })]);
  check('panel tools: memory reads work without ROMs, and are refused once the user\'s ROMs are in (no tool returns ROM memory directly)', !before.isError && s.romCodeIn() === 'roms'
    && romReads.every((r) => r.isError && r.structuredContent.error.code === 'rejected' && /no tool returns ROM memory directly/.test(r.structuredContent.error.detail)), J(romReads).slice(0, 300));
  await ptb.call('boot', { roms: false }, { base64: b64 });
  await ptb.call('load', { machine_id: 'm1', program: 'liza' }, { base64: b64 });
  const bigText = { content: [{ type: 'text', text: 'x'.repeat(panel.TEXT_MAX + 1) }] }, okText = { content: [{ type: 'text', text: 'x'.repeat(panel.TEXT_MAX) }] };
  const bigImage = { content: [{ type: 'text', text: '{}' }, { type: 'image', data: 'A'.repeat(panel.TEXT_MAX), mimeType: 'image/png' }] };
  check('panel tools: a result over 100,000 characters (text and image data together) is refused with too-long; one at the limit passes', panel.TEXT_MAX === 100000
    && panel.capped(bigText).structuredContent.error.code === 'too-long' && panel.capped(okText) === okText && panel.capped(bigImage).isError);
  const shot = await ptb.call('screenshot', { machine_id: 'm1', scale: 3 }, { base64: b64 });
  check('panel tools: the picture is awaited (the browser encodes it) and sent as an image block', !shot.isError && shot.content[1].type === 'image', J(shot).slice(0, 200));
  check('panel tools: run_frames is capped as on the local server', offered.find((t) => t.name === 'run_frames').inputSchema.properties.frames.maximum === T.RUN_FRAMES_MAX && T.WALL_MS <= 25000);
  // every bundled program file a model can ask for, on every model, is carried (B inline, A fetched)
  const needed = new Set(['demo.bin', ...Object.values(GAMES.list).map((g) => g.file)]);
  for (const id of Object.keys(profiles)) {
    const ss = new Session({ welcomeMenu: false });
    ss.switchMachine(id, undefined, { menu: false });
    for (const f of [ss.welcomeFile, ss.lizaFile]) if (f) needed.add(f);
  }
  check('panel tools: PROGRAM_FILES is every welcome, LIZA, demo and game file a model can need', J([...needed].sort()) === J([...panel.PROGRAM_FILES].sort()), J([...needed].sort()));

  // ---------------- the bridge, in a vm, playing the host ----------------
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'connector/view/bridge.js'), 'utf8');
  function bridge(cfg = { api: panel.PANEL_API, tools: [{ name: 'screen_text' }], version: 'v' }) {
    const sent = [], handlers = [];
    const parent = { postMessage: (m) => sent.push(JSON.parse(J(m))) };
    const win = { CLOADM_VIEW: cfg, parent };
    const ctx = vm.createContext({ window: win, addEventListener: (t, fn) => { if (t === 'message') handlers.push(fn); }, setTimeout, clearTimeout, AbortController, Date, performance, Promise, JSON, String, Array, Object, Map });
    win.window = win;
    vm.runInContext(bridgeSrc, ctx);
    const deliver = (data) => handlers.forEach((fn) => fn({ source: parent, data }));
    const reply = (method, result) => { const m = sent.find((x) => x.method === method); deliver({ jsonrpc: '2.0', id: m.id, result }); };
    return { sent, deliver, reply, B: win.CLOADM_BRIDGE };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await tick(); return fn(); };
  {
    const b = bridge();
    const first = b.sent.slice();
    check('bridge: ui/initialize is sent as the script runs, before any emulator (listChanged: true)', first.length === 1 && first[0].method === 'ui/initialize' && first[0].params.appCapabilities.tools.listChanged === true, J(first));
    b.reply('ui/initialize', { hostInfo: { name: 'stub' } });
    await tick();
    check('bridge: then ui/notifications/initialized', b.sent.some((m) => m.method === 'ui/notifications/initialized'));
    b.deliver({ jsonrpc: '2.0', id: 50, method: 'tools/list' });
    check('bridge: tools/list is answered at once, from the build\'s list', J(b.sent.find((m) => m.id === 50).result.tools) === J([{ name: 'screen_text' }]));
    b.deliver({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'screen_text', arguments: { machine_id: 'm1' } } });
    await tick();
    check('bridge: a call before the emulator is ready waits (no reply yet), and no list_changed yet', !b.sent.some((m) => m.id === 51) && !b.sent.some((m) => m.method === 'notifications/tools/list_changed'));
    const got = [];
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }, { name: 'peek' }], call: async (name, args) => { got.push([name, args]); return { content: [{ type: 'text', text: 'done' }] }; } });
    await waitFor(() => b.sent.some((m) => m.id === 51));
    check('bridge: attach sends notifications/tools/list_changed and serves the early call', b.sent.some((m) => m.method === 'notifications/tools/list_changed')
      && b.sent.find((m) => m.id === 51).result.content[0].text === 'done' && J(got) === J([['screen_text', { machine_id: 'm1' }]]));
    b.deliver({ jsonrpc: '2.0', id: 52, method: 'tools/list' });
    check('bridge: tools/list then gives the emulator\'s own list', J(b.sent.find((m) => m.id === 52).result.tools.map((t) => t.name)) === J(['screen_text', 'peek']));
    b.deliver({ jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'nope' } });
    b.deliver({ jsonrpc: '2.0', id: 54, method: 'ping' });
    check('bridge: an unknown tool is -32602; ping answers', b.sent.find((m) => m.id === 53).error.code === -32602 && J(b.sent.find((m) => m.id === 54).result) === '{}');
  }
  {
    const b = bridge();
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [] }) });
    check('bridge: an emulator ready before the handshake: list_changed waits for initialized', !b.sent.some((m) => m.method === 'notifications/tools/list_changed'));
    b.reply('ui/initialize', {});
    await tick();
    check('bridge: ... and is sent once it is', b.sent.filter((m) => m.method === 'notifications/tools/list_changed').length === 1);
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    b.B.attach({ api: panel.PANEL_API + 1, tools: [{ name: 'screen_text' }], call: async () => ({ content: [{ type: 'text', text: 'served anyway' }] }) });
    b.deliver({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    await waitFor(() => b.sent.some((m) => m.id === 60));
    const r = b.sent.find((m) => m.id === 60);
    const code = r?.result?.structuredContent?.error?.code ?? null;
    check('bridge: an emulator with another PANEL_API is refused: the call answers out-of-step', code === 'out-of-step', `got ${J(r)}`);
    check('bridge: ... and no list_changed is sent, and the status line says out-of-step', !b.sent.some((m) => m.method === 'notifications/tools/list_changed') && /out-of-step/.test(b.B.describe()), J(b.sent));
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    b.deliver({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    b.B.fail('blocked by CORS policy');
    await waitFor(() => b.sent.some((m) => m.id === 70));
    const r = b.sent.find((m) => m.id === 70);
    check('bridge: a failed start answers waiting calls at once with not-started and the reason', r && r.result.structuredContent.error.code === 'not-started' && /CORS/.test(r.result.structuredContent.error.detail), J(r));
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    let release;
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'run_frames' }], call: (n, a, { signal }) => new Promise((r) => { release = () => r({ content: [], aborted: signal.aborted }); }) });
    b.deliver({ jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'run_frames', arguments: {} } });
    await waitFor(() => release);
    b.deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 80 } });
    release();
    await tick(); await tick();
    check('bridge: a cancelled call gets no reply', !b.sent.some((m) => m.id === 80));
  }

  {
    const b = bridge();
    b.reply('ui/initialize', { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], theme: 'dark' } });
    await tick();
    const seen = [];
    b.B.onChange(() => seen.push(b.B.hostContext.displayMode));
    const initial = Object.assign({}, b.B.hostContext);
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
    check('bridge: hostContext starts as ui/initialize\'s and takes each host-context-changed in (the side-panel button reads displayMode)',
      initial.displayMode === 'inline' && b.B.hostContext.displayMode === 'fullscreen' && b.B.hostContext.theme === 'dark' && J(seen) === J(['fullscreen']), J([initial, b.B.hostContext, seen]));
    const asked = b.B.requestDisplayMode('inline');
    const req = b.sent.find((m) => m.method === 'ui/request-display-mode');
    b.deliver({ jsonrpc: '2.0', id: req.id, result: { mode: 'inline' } });
    await asked;
    check('bridge: the mode the host answers a request with is the context\'s at once', J(req.params) === J({ mode: 'inline' }) && b.B.hostContext.displayMode === 'inline', J(b.B.hostContext));
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'pip', styles: { variables: { x: 1 } }, toString: 'x', __proto__: { polluted: 1 } } });
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: 'not an object' });
    check('bridge: only the context keys the view reads are taken in (displayMode, availableDisplayModes, containerDimensions, theme)',
      J(Object.keys(b.B.hostContext).sort()) === J(['availableDisplayModes', 'displayMode', 'theme']) && b.B.hostContext.displayMode === 'pip' && !('polluted' in b.B.hostContext), J(b.B.hostContext));
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 }, platform: 'mobile', deviceCapabilities: { touch: true, hover: false }, userAgent: 'x', locale: 'en', toolInfo: {} } });
    check('bridge: a phone host\'s safeAreaInsets, platform and deviceCapabilities are taken in too, and nothing else (userAgent, locale, toolInfo are not)',
      J(Object.keys(b.B.hostContext).sort()) === J(['availableDisplayModes', 'deviceCapabilities', 'displayMode', 'platform', 'safeAreaInsets', 'theme']) && b.B.hostContext.safeAreaInsets.top === 47, J(b.B.hostContext));
    const before = b.sent.length;
    const first = b.B.sizeChanged(390, 612.4), again = b.B.sizeChanged(390, 613), other = b.B.sizeChanged(600, 760), none = b.B.sizeChanged(0, 10);
    const sizes = b.sent.slice(before);
    check('bridge: sizeChanged sends ui/notifications/size-changed { width, height } (whole pixels, rounded up), not again for the same size, and nothing for an empty one',
      first && !again && other && !none && J(sizes) === J([{ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 390, height: 613 } }, { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 600, height: 760 } }])
      && /size 600×760 ×2/.test(b.B.describe()), J(sizes));
  }
  {
    // sizes asked for before the host's initialized has arrived are held: none goes out first, and one goes after it, the latest
    const b = bridge();
    const early1 = b.B.sizeChanged(390, 500), early2 = b.B.sizeChanged(390, 600);
    const beforeInit = b.sent.filter((m) => m.method === 'ui/notifications/size-changed');
    check('bridge: no size-changed goes out before the host\'s initialized has arrived', !early1 && !early2 && !beforeInit.length, J(b.sent.map((m) => m.method)));
    b.reply('ui/initialize', {});
    await tick();
    const sentSizes = b.sent.filter((m) => m.method === 'ui/notifications/size-changed');
    const order = b.sent.map((m) => m.method).filter((x) => x === 'ui/notifications/initialized' || x === 'ui/notifications/size-changed');
    check('bridge: once initialized is sent, exactly one size-changed follows, with the latest size, after it',
      sentSizes.length === 1 && J(sentSizes[0].params) === J({ width: 390, height: 600 }) && J(order) === J(['ui/notifications/initialized', 'ui/notifications/size-changed']) && /size 390×600 ×1/.test(b.B.describe()), J([order, sentSizes]));
    check('bridge: the same size asked for again after that is not sent twice', !b.B.sizeChanged(390, 600) && b.sent.filter((m) => m.method === 'ui/notifications/size-changed').length === 1);
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [], isError: true, structuredContent: { error: { code: 'bad-argument' } } }) });
    b.deliver({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    await waitFor(() => b.sent.some((m) => m.id === 90));
    const d1 = b.B.describe();
    const ok = bridge();
    ok.reply('ui/initialize', {});
    ok.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
    ok.deliver({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    await waitFor(() => ok.sent.some((m) => m.id === 91));
    check('bridge: Details names the last call and how it ended ("screen_text error bad-argument", "screen_text ok"), so a call the host never delivered (calls ×0) can be told from one the view refused',
      /calls ×1, .*last call screen_text error bad-argument \d+ ms/.test(d1) && /last call screen_text ok \d+ ms/.test(ok.B.describe()), `${d1} | ${ok.B.describe()}`);
  }

  // ---------------- a blocked load (connector/view/reach.js, in Open CLOADM's view), in a vm with the bridge ----------------
  const reachSrc = fs.readFileSync(path.join(ROOT, 'connector/view/reach.js'), 'utf8');
  check('reach: Open CLOADM\'s view carries the detector, after the bridge and before the module; the offline copy does not',
    views.site.indexOf('CLOADM_REACH = {') > views.site.indexOf('CLOADM_BRIDGE = {') && views.site.indexOf('CLOADM_REACH = {') < views.site.indexOf('<script type="module">')
    && views.site.includes(`const ORIGIN = ${J(ORIGIN)};`) && /\.then\(\(m\) => \{ CLOADM_REACH\.loaded\(\); return m\.start\(\); \}, \(e\) => CLOADM_REACH\.importFailed\(e\)\)/.test(views.site)
    && !views.inline.includes('CLOADM_REACH = {'));
  // host: the ui/initialize answer's hostCapabilities, or null to answer later; waitMs stands in for 8 s
  function reach({ caps = null, waitMs = 8000 } = {}) {
    const sent = [], handlers = [], docHandlers = [], els = {};
    const elem = (id) => (els[id] = els[id] || { id, textContent: '', className: '' });
    const parent = { postMessage: (m) => sent.push(JSON.parse(J(m))) };
    const win = { CLOADM_VIEW: { api: panel.PANEL_API, tools: [{ name: 'screen_text' }], version: 'v' }, parent };
    const document = { getElementById: elem, addEventListener: (t, fn) => { if (t === 'securitypolicyviolation') docHandlers.push(fn); } };
    const ctx = vm.createContext({ window: win, document, addEventListener: (t, fn) => { if (t === 'message') handlers.push(fn); }, setTimeout, clearTimeout, AbortController, Date, performance, Promise, JSON, String, Array, Object, Map });
    win.window = win;
    vm.runInContext(bridgeSrc, ctx);
    vm.runInContext(reachSrc.replace('__ORIGIN__', J(ORIGIN)).replace('const WAIT_MS = 8000;', `const WAIT_MS = ${waitMs};`), ctx);
    const deliver = (data) => handlers.forEach((fn) => fn({ source: parent, data }));
    const init = (c) => { const m = sent.find((x) => x.method === 'ui/initialize'); deliver({ jsonrpc: '2.0', id: m.id, result: { hostInfo: { name: 'stub' }, hostCapabilities: c } }); };
    if (caps) init(caps);
    const violate = (blockedURI) => docHandlers.forEach((fn) => fn({ blockedURI, effectiveDirective: 'script-src-elem' }));
    const call = async (id) => { deliver({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'screen_text', arguments: {} } }); await waitFor(() => sent.some((m) => m.id === id)); return sent.find((m) => m.id === id); };
    return { sent, init, violate, call, els, R: win.CLOADM_REACH, B: win.CLOADM_BRIDGE };
  }
  const errOf = (r) => r && r.result && r.result.structuredContent && r.result.structuredContent.error;
  const MESSAGE = 'This app can\'t reach cloadm.dev here. Ask Claude to open the offline copy.';
  {
    // the host keeps cloadm.dev out: resourceDomains null
    const v = reach({ caps: { sandbox: { csp: { resourceDomains: null, connectDomains: null } }, message: {} } });
    await tick();
    const m = v.sent.find((x) => x.method === 'ui/message'), r = await v.call(90);
    check('reach: a host whose csp has resourceDomains null: the status line says it can\'t reach cloadm.dev, and Details says why and how it was reported',
      v.R.MESSAGE === MESSAGE && v.els.status?.textContent === MESSAGE && v.els.status?.className === 'error' && v.els.announce?.textContent === MESSAGE
      && /^blocked: the host does not allow https:\/\/cloadm\.dev .*resourceDomains null.* · reported: message · bridge: /.test(v.els.st?.textContent), J(v.els));
    check('reach: ... Claude is told at once, by ui/message, to open the offline copy without asking',
      !!m && m.params.role === 'user' && m.params.content.length === 1 && /open_emulator_inline/.test(m.params.content[0].text) && /No need to ask/.test(m.params.content[0].text) && v.R.reported === 'message', J(m));
    check('reach: ... and every call is answered "blocked", its remedy the offline copy', errOf(r) && errOf(r).code === 'blocked' && /open_emulator_inline/.test(errOf(r).remedy) && /resourceDomains null/.test(errOf(r)?.detail), J(r));
    // the host's word alone is a soft block: should the module load after all, it attaches and Claude is told so
    v.R.loaded();
    const took = v.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [{ type: 'text', text: 'loaded after all' }] }) });
    const back = v.sent.filter((x) => x.method === 'ui/message');
    const r2 = await v.call(93);
    check('reach: ... a block on the host\'s csp alone is soft: a module that loads after all attaches, serves calls, and Claude is told on the same channel to keep this view',
      took && v.R.blocked === null && back.length === 2 && /loaded after all/.test(back[1].params.content[0].text) && /keep using this view/.test(back[1].params.content[0].text) && !/slow/.test(back[1].params.content[0].text)
      && v.R.reported === 'message, then taken back' && r2.result.content[0].text === 'loaded after all' && v.els.status?.textContent !== MESSAGE, J([took, back.map((m) => m.params.content[0].text), v.R.reported]));
  }
  for (const spelled of ['https://cloadm.dev/', 'cloadm.dev', 'CLOADM.DEV/', 'https://CloadM.dev']) {
    // the site written another way by the host is still the site
    const v = reach({ caps: { sandbox: { csp: { resourceDomains: [spelled] } }, message: {} } });
    await tick();
    check(`reach: a host that allows the site written ${J(spelled)} is not blocked (no message, no report)`, v.R.blocked === null && !v.sent.some((x) => x.method === 'ui/message') && !(v.els.status && v.els.status.textContent === MESSAGE), J([v.R.blocked, v.sent.map((x) => x.method)]));
  }
  {
    // a soft block then a hard sign (the import fails): hard, and a late module is not taken
    const v = reach({ caps: { sandbox: { csp: { resourceDomains: ['https://elsewhere.example'] } }, message: {} } });
    await tick();
    const softly = v.R.blocked;
    v.R.importFailed(new Error('Failed to fetch dynamically imported module'));
    const r = await v.call(94);
    check('reach: a soft block (the csp) gives way to a hard one (the import failed): calls say so, a module after that is not taken, and Claude was told once',
      /does not allow/.test(softly) && /import of panel\.js failed/.test(v.R.blocked) && /import of panel\.js failed/.test(errOf(r)?.detail)
      && v.B.attach({ api: panel.PANEL_API, tools: [], call: async () => ({ content: [] }) }) === false && v.sent.filter((x) => x.method === 'ui/message').length === 1, J([softly, v.R.blocked]));
  }
  {
    // the wait runs out before the handshake, and the handshake then allows the site: the block is taken back unsaid
    const v = reach({ waitMs: 20 });
    await waitFor(() => v.R.blocked);
    const during = { blocked: v.R.blocked, status: v.els.status?.textContent, failed: v.B.failed };
    v.init({ sandbox: { csp: { resourceDomains: [ORIGIN] } }, message: {}, updateModelContext: {} });
    await tick();
    check('reach: a wait that ran out before a handshake that allows the site is taken back: nothing sent to Claude, the bridge never failed, the status line cleared',
      /nothing loaded/.test(during.blocked) && during.status === MESSAGE && during.failed === null && v.R.blocked === null && v.R.reported === null
      && !v.sent.some((x) => /^ui\/(message|update-model-context)$/.test(x.method)) && v.B.failed === null && v.els.status?.textContent !== MESSAGE, J([during, v.R.blocked, v.sent.map((x) => x.method)]));
  }
  {
    // slow, but the host allows the site: no timeout block (a failed import would still count)
    const v = reach({ caps: { sandbox: { csp: { resourceDomains: [ORIGIN] } }, message: {} }, waitMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    check('reach: no timeout block when the host\'s csp allows the site (slow is not blocked)', v.R.blocked === null && !v.sent.some((x) => x.method === 'ui/message'), J(v.R.blocked));
  }
  {
    // the host lets cloadm.dev in: nothing to say
    const v = reach({ caps: { sandbox: { csp: { resourceDomains: [ORIGIN], connectDomains: [ORIGIN] } }, message: {}, updateModelContext: {} }, waitMs: 40 });
    await tick();
    v.violate('https://elsewhere.example/x.js');
    const before = { blocked: v.R.blocked, handshake: !!v.B.host };
    v.R.loaded();
    await new Promise((r) => setTimeout(r, 80));
    check('reach: a host that allows cloadm.dev, a load in time, a violation for another site: no message, no report, no failure',
      before.handshake && before.blocked === null && v.R.blocked === null && v.R.reported === null && !v.sent.some((x) => /^ui\/(message|update-model-context)$/.test(x.method)) && !v.els.status && !v.B.failed, J([before, v.sent.map((x) => x.method)]));
  }
  {
    // no csp from the host, so nothing is concluded from it; a policy violation for the site is
    const v = reach({ caps: { updateModelContext: {} } });
    await tick();
    const quiet = v.R.blocked === null;
    v.violate(`${ORIGIN}/connector/view/panel.js`);
    const u = v.sent.find((x) => x.method === 'ui/update-model-context');
    check('reach: no csp from the host is not a block; a securitypolicyviolation for cloadm.dev is, told through ui/update-model-context when that is what the host offers',
      quiet && /policy blocked https:\/\/cloadm\.dev\/connector\/view\/panel\.js \(script-src-elem\)/.test(v.R.blocked) && !!u && /open_emulator_inline/.test(u.params.content[0].text)
      && !v.sent.some((x) => x.method === 'ui/message') && v.R.reported === 'model context', J([v.R.blocked, u]));
  }
  {
    // the import fails before the handshake (the view's error handler said not-started first): blocked takes its place,
    // and the report waits for the host
    const v = reach();
    v.B.fail('Failed to fetch dynamically imported module');
    v.R.importFailed(new Error('Failed to fetch dynamically imported module'));
    const before = v.sent.filter((x) => /^ui\/(message|update-model-context)$/.test(x.method)).length;
    v.init({});
    await tick();
    const r = await v.call(91);
    check('reach: a failed import is a block, in place of the not-started from the same load; with no channel offered, the tool results say it',
      before === 0 && v.R.reported === 'tool results only' && errOf(r)?.code === 'blocked' && /import of panel\.js failed/.test(errOf(r)?.detail) && v.els.status?.textContent === MESSAGE, J([v.R.reported, r]));
  }
  {
    // nothing loaded in time: blocked; the module arriving after all still starts
    const v = reach({ caps: { message: {} }, waitMs: 30 });
    await waitFor(() => v.R.blocked);
    const late = v.R.blocked, m = v.sent.find((x) => x.method === 'ui/message');
    v.R.loaded();
    const took = v.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [{ type: 'text', text: 'late but here' }] }) });
    const r = await v.call(92);
    const msgs = v.sent.filter((x) => x.method === 'ui/message').map((x) => x.params.content[0].text);
    check('reach: nothing loaded within the wait is a block (reported), and a module that arrives later still attaches and serves calls',
      /nothing loaded from https:\/\/cloadm\.dev within/.test(late) && !!m && took && v.R.blocked === null && r.result.content[0].text === 'late but here', J([late, r]));
    check('reach: ... and Claude, told to open the offline copy, is then told the view loaded after all and to keep it',
      msgs.length === 2 && /open_emulator_inline/.test(msgs[0]) && /loaded after all/.test(msgs[1]) && /keep using this view/.test(msgs[1]) && !/slow/.test(msgs[1]) && !/open_emulator_inline/.test(msgs[1]), J(msgs));
  }

  // ---------------- the view's controls (connector/view/ui.js), the parts without a DOM ----------------
  {
    const ui = await imp('connector/view/ui.js');
    const sizes = [[376, 600], [576, 700], [876, 2000], [876, 400], [100, 2000], [376, null], [876, null]].map(([w, h]) => [w, h, ui.screenSize(w, h)]);
    const fits = sizes.every(([w, h, s]) => s.width <= w && (h == null || s.height <= h) && Math.abs(s.width / s.height - 4 / 3) < 0.01
      && (w - s.width < 2 || (h != null && h - s.height < 1)));
    check('screen: the largest 4:3 picture that fits, to the pixel, in the limiting dimension; with no height given (inline), the full width', fits
      && J(ui.screenSize(376, null)) === J({ width: 376, height: 282 }) && J(ui.screenSize(876, 400)) === J({ width: 533, height: 400 }), J(sizes));
    check('screen: the height is fixed in the side panel and fullscreen, or when the host gives one; inline it follows the content',
      ui.fixedHeight({ displayMode: 'fullscreen' }) && ui.fixedHeight({ displayMode: 'pip' }) && ui.fixedHeight({ displayMode: 'inline', containerDimensions: { height: 500 } })
      && !ui.fixedHeight({ displayMode: 'inline' }) && !ui.fixedHeight({ displayMode: 'inline', containerDimensions: { maxHeight: 900 } }) && !ui.fixedHeight({}));
    const names = { model: (id) => ({ coco3: 'CoCo 3' })[id], program: (id) => ({ liza: 'LIZA' })[id] };
    const typing = ui.describeCall('type_text', { text: 'DIR\n' }), keys = ui.describeCall('press_keys', { keys: ['SHIFT', 'A'] });
    const load = ui.describeCall('load', { program: 'liza' }, names), sw = ui.describeCall('switch_machine', { model: 'coco3' }, names), reset = ui.describeCall('reset');
    check('chip: typing says "Claude is typing: " and the keys (Enter as ↵), then "Claude typed "; a load, a switch and a reset say what they did',
      typing.now === 'Claude is typing: ' && typing.past === 'Claude typed ' && typing.keys === 'DIR↵' && !typing.read && keys.keys === 'SHIFT + A'
      && load.past === 'Claude loaded LIZA' && !load.keys && sw.past === 'Claude switched to the CoCo 3' && reset.past === 'Claude reset the machine', J([typing, keys, load, sw, reset]));
    const reads = ['screen_text', 'screenshot', 'peek', 'find_bytes'].map((n) => ui.describeCall(n, {}, { read: true }));
    check('chip: a reading call is a quiet "Claude read the screen" or "Claude read memory"', reads.every((r) => r.read && !r.keys)
      && J(reads.map((r) => r.now)) === J(['Claude read the screen', 'Claude read the screen', 'Claude read memory', 'Claude read memory']), J(reads));
    const say = (keys, read = false) => ui.announcement(Object.assign(ui.describeCall(read ? 'screen_text' : 'type_text', { text: keys }, { read })));
    const short = say('DIR\n'), mid = say('A'.repeat(100)), long = say('B'.repeat(2000));
    check('announcement: short keys whole, more than 40 cut at 40 with an ellipsis, a long text by its length; none for a read',
      short === 'Claude is typing: DIR↵' && mid === `Claude is typing: ${'A'.repeat(40)}…` && long === 'Claude is typing 2,000 characters' && say('', true) === null, J([short, mid, long]));
    const phone = { safeAreaInsets: { top: 47.4, right: 0, bottom: 34, left: 0 } };
    check('insets: the host\'s safeAreaInsets when it gives all four (rounded, kept within 0..200), inline or not, touch or not',
      J(ui.insets(phone)) === J({ top: '47px', right: '0px', bottom: '34px', left: '0px' }) && J(ui.insets({ displayMode: 'fullscreen', safeAreaInsets: { top: 900, right: -5, bottom: 0, left: 0 } }, { touch: true })) === J({ top: '200px', right: '0px', bottom: '0px', left: '0px' }), J(ui.insets(phone)));
    const reserve = ui.insets({ displayMode: 'fullscreen' }, { touch: true });
    check('insets: without them, a touch host in the side panel or fullscreen keeps the device\'s safe area and at least 56 px at the top (a phone app\'s title chip); a desktop, or inline, none; incomplete insets are not used',
      reserve.top === 'max(env(safe-area-inset-top, 0px), 56px)' && reserve.bottom === 'env(safe-area-inset-bottom, 0px)' && ui.TOP_RESERVE === 56
      && J(ui.insets({ displayMode: 'fullscreen' })) === J(ui.insets({})) && ui.insets({}).top === '0px' && ui.insets({ displayMode: 'inline' }, { touch: true }).top === '0px'
      && J(ui.insets({ displayMode: 'fullscreen', safeAreaInsets: { top: 10 } }, { touch: true })) === J(reserve), J(reserve));
    check('touch: the host\'s platform "mobile" or deviceCapabilities.touch, a coarse pointer, or a touch seen; a host saying touch: false over a coarse pointer',
      ui.touchHost({ platform: 'mobile' }) && ui.touchHost({ deviceCapabilities: { touch: true } }) && ui.touchHost({}, { coarse: true }) && ui.touchHost({ deviceCapabilities: { touch: false } }, { seen: true })
      && !ui.touchHost({}) && !ui.touchHost({ platform: 'desktop' }) && !ui.touchHost({ deviceCapabilities: { touch: false } }, { coarse: true }));
    check('size: the content height is the screen, its padding and what lies around it, rounded up to a whole pixel', ui.contentHeight(282, 24, 120.2) === 427 && ui.contentHeight(ui.screenSize(366).height, 24, 300) === 598);
    const tl = await imp('js/ui/touch-layout.js');
    check('keys: what an on-screen key sends (the page\'s and the view\'s): a letter, SHIFT + 1 ("!" for the stub), ENTER, the space bar ("_"), ← as LEFT (backspace 8), → as RIGHT (9); the full keyboard\'s 50 keys',
      J(tl.keyPress('A')) === J({ names: ['A'], code: 65 }) && J(tl.keyPress('1', true)) === J({ names: ['SHIFT', '1'], code: 33 }) && J(tl.keyPress('ENTER')) === J({ names: ['ENTER'], code: 13 })
      && J(tl.keyPress('_')) === J({ names: ['SPACE'], code: 32 }) && J(tl.keyPress('←', true)) === J({ names: ['SHIFT', 'LEFT'], code: 8 }) && tl.FULL.join(' ').split(' ').length === 50 && J(tl.keyPress('→')) === J({ names: ['RIGHT'], code: 9 }), J([tl.keyPress('1', true), tl.keyPress('←', true)]));
    const S = await imp('js/session.js');
    check('keys: a program\'s mode from what it is played with: the arrows the Pad, a joystick the Stick, the keyboard (and nothing) the Keys; 2048 and Minesweeper the Pad, LIZA the Keys',
      tl.programMode(null) === 'keys' && tl.programMode({ input: 'arrows' }) === 'pad' && tl.programMode({ input: 'joystick' }) === 'joystick' && tl.programMode({ input: 'keyboard' }) === 'keys'
      && tl.programMode(S.GAMES.list[2048].controls) === 'pad' && tl.programMode(S.GAMES.list.minesweeper.controls) === 'pad' && J(S.GAMES.list.minesweeper.controls.extra) === '["F"]'
      && tl.programMode(S.PROGRAM_CONTROLS.liza) === 'keys' && J(tl.MODES) === '["keys","pad","joystick"]' && !tl.DPAD.flat().includes('BREAK') && !tl.PAD_KEYS.includes('BREAK'));
    const vt = await imp('connector/view/touch.js');
    const kv = new Map(), works = vt.modeMemory({ getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => kv.set(k, v) });
    works.set('dragon64.liza', 'pad');
    const thrower = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
    const off = vt.modeMemory(thrower), none = vt.modeMemory(null);
    let threw = null;
    try { off.set('dragon64.liza', 'pad'); none.set('x', 'keys'); } catch (e) { threw = e; }
    check('keys: the choice is kept in the view\'s storage when it works (cloadm.touchMode.<machine>.<program>); when the storage throws, or there is none, in memory, silently; nothing stored is null',
      kv.get('cloadm.touchMode.dragon64.liza') === 'pad' && vt.modeMemory({ getItem: (k) => kv.get(k) ?? null, setItem() {} }).get('dragon64.liza') === 'pad'
      && !threw && off.get('dragon64.liza') === 'pad' && none.get('x') === 'keys' && vt.modeMemory(thrower).get('dragon64.liza') === null && works.get('nothing') === null, J([...kv]));
    const unnamed = offered.filter((t) => !t.annotations.readOnlyHint).filter((t) => /^Claude: /.test(ui.describeCall(t.name, {}, { title: t.title }).now)).map((t) => t.name);
    check('chip: every panel tool that acts (readOnlyHint false) has its own words', !unnamed.length, unnamed.join(','));
  }

  // ---------------- the PANEL_API contract ----------------
  // What the view's HTML (built into the Worker) and the emulator module (served by cloadm.dev) expect of each other:
  // the bridge's members and what attach() reads, the CLOADM_VIEW fields and who reads them, the shell's element ids.
  // Its hash is recorded with the PANEL_API it belongs to: change the contract and this fails until PANEL_API is raised
  // (connector/view/tools.js) and the new pair recorded here.
  const CONTRACT = { api: 3, sha256: '032f6a8f7ac8a46dfe50e6b6fbd417fc0d4a1fe7bf5607567d7796229721f80e' };
  {
    const b = bridge();
    const uniq = (re, text) => [...new Set([...text.matchAll(re)].map((m) => m[1]))].sort();
    const panelSrc = fs.readFileSync(path.join(ROOT, 'connector/view/panel.js'), 'utf8');
    const shellIds = uniq(/\bid="([^"]+)"/g, views.site.replace(/<script[\s\S]*?<\/script>/g, ''));
    const contract = {
      bridgeMembers: Object.getOwnPropertyNames(b.B).sort(),
      arity: { attach: b.B.attach.length, fail: b.B.fail.length, onChange: b.B.onChange.length, requestDisplayMode: b.B.requestDisplayMode.length },
      attachReads: uniq(/\b(?:x|impl)\.(\w+)/g, bridgeSrc),
      viewFields: [...new Set([...Object.keys(cfgA), ...Object.keys(cfgB)])].sort(),
      cfgReads: uniq(/\bcfg\.(\w+)/g, bridgeSrc + panelSrc),
      panelUsesBridge: uniq(/\bbridge\.(\w+)/g, panelSrc),
      panelIds: uniq(/\$\('([\w-]+)'\)/g, panelSrc),
      shellIds,
    };
    const sha = require('crypto').createHash('sha256').update(J(contract)).digest('hex');
    const missingIds = contract.panelIds.filter((id) => !shellIds.includes(id));
    check('PANEL_API contract: every element panel.js uses is in the shell', !missingIds.length, missingIds.join(','));
    const api = panel.PANEL_API;
    check(`PANEL_API contract: the recorded hash is this contract's, under PANEL_API ${api}`, sha === CONTRACT.sha256 && api === CONTRACT.api,
      sha === CONTRACT.sha256 ? `PANEL_API is ${api} but the contract was recorded under ${CONTRACT.api}: record { api: ${api}, sha256: '${sha}' }`
        : api === CONTRACT.api ? `the contract changed (${sha}) but PANEL_API is still ${api}: raise PANEL_API in connector/view/tools.js, then record the new pair ${J(contract)}`
          : `PANEL_API is now ${api}: record { api: ${api}, sha256: '${sha}' }`);
  }

  // ---------------- what the docs claim about ROMs ----------------
  // ROM memory is not sealed: a program run on the machine can read it (tests/mcp.test.js pins that). Nothing may claim
  // that no ROM byte leaves the panel; the guide must say what is true instead.
  const claimFiles = ['docs/mcp.md', 'CHANGELOG.md', 'README.md', 'skills/cloadm/SKILL.md', ...['view/tools.js', 'view/panel.js', 'view/bridge.js', 'worker/src/server.js', 'build.js'].map((f) => `connector/${f}`), 'js/mcp/tools.js'];
  const overclaims = claimFiles.filter((f) => /no ROM bytes? (ever )?leaves?|never leaves? (this host|the panel)|ROMs? (never|cannot) leave/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no file claims that no ROM byte leaves the panel; the guide says a determined agent can infer ROM contents through execution', !overclaims.length
    && /a\s+determined agent can infer ROM contents through execution/.test(fs.readFileSync(path.join(ROOT, 'docs/mcp.md'), 'utf8')), overclaims.join(', '));

  console.log(`${n - fail}/${n} connector checks passed`);
  process.exitCode = fail ? 1 : 0;
// (straight to stdout: a failure while the Worker is probed comes while console is stubbed)
})().catch((e) => { process.stdout.write(`FAIL ${String(e.stack).slice(0, 2000)}\n`); process.exitCode = 1; });
