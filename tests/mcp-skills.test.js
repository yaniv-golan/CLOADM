// The agent skill served over MCP: the Skills extension, io.modelcontextprotocol/skills (js/mcp/skills.js), from both
// of CLOADM's servers, the stdio one (node cli/cloadm.js --mcp, cli/mcp.js) and the connector's Worker
// (connector/worker/src/server.js, with the views connector/build.js makes):
//  * the server declares the extension (and `resources`) in server/discover (2026-07-28), and in an initialize result
//    only to a client whose initialize declared it; a client that does not negotiate it sees the handshake, tools and
//    resources it saw before; --no-skills serves none of it;
//  * skills/list gives the cloadm skill, its frontmatter as SKILL.md has it, and a complete manifest (every file under
//    skills/cloadm/, each with its size and sha-256), all derived here from the files on disk, not from the code;
//  * skills/get and resources/read give those files byte for byte as skills/cloadm/ (and .agents/skills/cloadm/) hold them;
//  * errors: an unknown skill, a file URI given to skills/get, an unknown skill file, a missing uri (-32602);
//  * the Worker's 2026-07-28 HTTP rules: MCP-Protocol-Version, Mcp-Method and Mcp-Name checked against the body (400,
//    -32020), an unknown version (400, -32022), an unknown method (404, -32601);
//  * the module's own checks: frontmatter it cannot read, a skill named unlike its folder, a file that is not text.
// Run: node tests/mcp-skills.test.js
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const EXT = 'io.modelcontextprotocol/skills';
const MODERN = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'mcp-skills.test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-skills-')));
fs.mkdirSync(path.join(TMP, 'home'));
const ENV = Object.assign({}, process.env, { HOME: path.join(TMP, 'home'), APPDATA: path.join(TMP, 'home', 'AppData') });

// ---------------- what the skill is, from the files alone ----------------
const SKILL_DIR = path.join(ROOT, 'skills', 'cloadm'), AGENTS_DIR = path.join(ROOT, '.agents', 'skills', 'cloadm');
const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])).sort();
const FILES = walk(SKILL_DIR);
const bytesOf = (p) => fs.readFileSync(path.join(SKILL_DIR, p));
const WANT_MANIFEST = FILES.map((p) => ({ uri: `skill://cloadm/${p}`, digest: `sha256:${crypto.createHash('sha256').update(bytesOf(p)).digest('hex')}`, size: bytesOf(p).length }));
const skillMd = bytesOf('SKILL.md').toString('utf8');
const fmLine = (key) => { const m = new RegExp(`^${key}: (.*)$`, 'm').exec(skillMd.split('\n---')[0]); return m && m[1]; };
const WANT_FRONTMATTER = { name: 'cloadm', description: fmLine('description'), compatibility: fmLine('compatibility'), license: fmLine('license') };
// the manifest's order is the files', sorted by path: compare as sets so a different order is not a failure
const sameManifest = (got) => Array.isArray(got) && J([...got].sort((a, b) => (a.uri < b.uri ? -1 : 1))) === J(WANT_MANIFEST);
// a skill entry as the spec has it, against the files
const goodSkill = (s) => !!s && s.uri === 'skill://cloadm/SKILL.md' && J(s.frontmatter) === J(WANT_FRONTMATTER) && sameManifest(s.resources);
// every file read through `read(uri) -> result`, its text's bytes against the folder's
async function allBytesSame(read) {
  const bad = [];
  for (const p of FILES) {
    const r = await read(`skill://cloadm/${p}`);
    const c = r && r.contents && r.contents[0];
    if (!c || c.uri !== `skill://cloadm/${p}` || c.mimeType !== 'text/markdown' || !Buffer.from(c.text, 'utf8').equals(bytesOf(p))) bad.push(p);
  }
  return bad;
}

// ---------------- a stdio server ----------------
const spawned = [];
function server(args = []) {
  const p = spawn(process.execPath, [CLI, '--mcp', ...args], { cwd: ROOT, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.push(p);
  const waiters = new Map();
  let buf = '', id = 0;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  return {
    request(method, params = {}, meta = null) {
      const rid = ++id;
      p.stdin.write(J({ jsonrpc: '2.0', id: rid, method, params: Object.assign({}, params, meta ? { _meta: meta } : {}) }) + '\n');
      return new Promise((resolve, reject) => {
        waiters.set(rid, resolve);
        setTimeout(() => { if (waiters.delete(rid)) reject(new Error(`no reply to ${method}`)); }, 30000).unref();
      });
    },
    close: () => new Promise((resolve) => { p.on('close', resolve); p.stdin.end(); }),
  };
}

(async () => {
  check('the skill folder and its .agents copy are byte for byte the same (the one source both servers serve)',
    J(walk(AGENTS_DIR)) === J(FILES) && FILES.every((p) => fs.readFileSync(path.join(AGENTS_DIR, p)).equals(bytesOf(p))) && FILES.includes('SKILL.md') && FILES.length >= 2, J(FILES));
  check('the expected frontmatter was read from SKILL.md (name, description, compatibility, license)', Object.values(WANT_FRONTMATTER).every((v) => typeof v === 'string' && v.length > 2), J(WANT_FRONTMATTER));

  // ---------------- stdio: a 2026-07-28 client ----------------
  const s = server();
  const disc = await s.request('server/discover', {}, META);
  const caps = disc.result && disc.result.capabilities;
  check('stdio server/discover: declares the skills extension and resources', !!caps && J(caps.extensions) === J({ [EXT]: {} }) && !!caps.resources && !!caps.tools, J(caps));
  const list = await s.request('skills/list', {}, META);
  check('stdio skills/list: the cloadm skill, frontmatter and complete manifest as on disk', list.result && list.result.skills.length === 1 && goodSkill(list.result.skills[0]), J(list).slice(0, 600));
  check('stdio skills/list: resultType complete, ttlMs, cacheScope, the server in _meta, no cursor (one page)', list.result.resultType === 'complete' && Number.isInteger(list.result.ttlMs) && list.result.ttlMs > 0
    && ['public', 'private'].includes(list.result.cacheScope) && list.result._meta['io.modelcontextprotocol/serverInfo'].name === 'cloadm-files' && !('nextCursor' in list.result), J(list.result).slice(0, 300));
  const get = await s.request('skills/get', { uri: 'skill://cloadm/SKILL.md' }, META);
  check('stdio skills/get: the same skill entry as skills/list', get.result && J(get.result.skill) === J(list.result.skills[0]) && get.result.resultType === 'complete', J(get).slice(0, 300));
  const badRead = await allBytesSame(async (uri) => (await s.request('resources/read', { uri }, META)).result);
  check('stdio resources/read: every file in the manifest, byte for byte skills/cloadm/', badRead.length === 0, J(badRead));
  const rlist = await s.request('resources/list', {}, META);
  check('stdio resources/list: the skill files', rlist.result && J(rlist.result.resources.map((r) => r.uri).sort()) === J(WANT_MANIFEST.map((r) => r.uri).sort()), J(rlist).slice(0, 300));
  // errors
  const unknown = await s.request('skills/get', { uri: 'skill://nope/SKILL.md' }, META);
  const fileUri = await s.request('skills/get', { uri: 'skill://cloadm/references/debugging.md' }, META);
  const noUri = await s.request('skills/get', {}, META);
  const noFile = await s.request('resources/read', { uri: 'skill://cloadm/references/nope.md' }, META);
  const escape = await s.request('resources/read', { uri: 'skill://cloadm/../../package.json' }, META);
  check('stdio errors: an unknown skill, a file URI to skills/get, no uri, an unknown or escaping file: each -32602 with no result',
    [unknown, fileUri, noUri, noFile, escape].every((r) => r.error && r.error.code === -32602 && !r.result) && /skill:\/\/nope\/SKILL\.md/.test(unknown.error.message), J([unknown, fileUri, noUri, noFile, escape]));
  // ---------------- stdio: a handshake client ----------------
  const plain = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const plainCalls = await Promise.all([['skills/list', {}], ['skills/get', { uri: 'skill://cloadm/SKILL.md' }], ['resources/read', { uri: 'skill://cloadm/SKILL.md' }], ['resources/list', {}]].map(([m, p]) => s.request(m, p)));
  check('stdio, a handshake client that did not declare the extension: the skill methods are unknown (-32601), as they always were', plainCalls.every((r) => r.error && r.error.code === -32601), J(plainCalls));
  const asks = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: { extensions: { [EXT]: {} } }, clientInfo: { name: 't', version: '1' } });
  check('stdio initialize, a client that does not declare the extension: the capabilities it always had (tools only)', J(plain.result.capabilities) === J({ tools: { listChanged: false } }), J(plain.result.capabilities));
  check('stdio initialize, a client that declares it: skills and resources declared', J(asks.result.capabilities.extensions) === J({ [EXT]: {} }) && !!asks.result.capabilities.resources, J(asks.result.capabilities));
  const legacyList = await s.request('skills/list');
  check('stdio skills/list on the handshake revisions: the same skill', legacyList.result && goodSkill(legacyList.result.skills[0]), J(legacyList).slice(0, 300));
  const tools = await s.request('tools/list');
  await s.close();

  // ---------------- stdio: --no-skills ----------------
  const ns = server(['--no-skills']);
  const nsDisc = await ns.request('server/discover', {}, META);
  const nsInit = await ns.request('initialize', { protocolVersion: '2025-11-25', capabilities: { extensions: { [EXT]: {} } } });
  const nsCalls = await Promise.all([['skills/list', {}], ['skills/get', { uri: 'skill://cloadm/SKILL.md' }], ['resources/read', { uri: 'skill://cloadm/SKILL.md' }], ['resources/list', {}]]
    .map(([m, p]) => ns.request(m, p, META)));
  const nsTools = await ns.request('tools/list');
  check('--no-skills: nothing declared, in either era', J(nsDisc.result.capabilities) === J({ tools: { listChanged: false } }) && J(nsInit.result.capabilities) === J({ tools: { listChanged: false } }), J([nsDisc.result.capabilities, nsInit.result.capabilities]));
  check('--no-skills: skills/list, skills/get, resources/read and resources/list are unknown methods (-32601), as before the extension', nsCalls.every((r) => r.error && r.error.code === -32601), J(nsCalls));
  check('the tools are the same with or without skills', J(nsTools.result) === J(tools.result) && tools.result.tools.length > 10);
  await ns.close();
  const bad = await new Promise((resolve) => { const p = spawn(process.execPath, [CLI, '--mcp', '--no-skills=1'], { cwd: ROOT, env: ENV }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (c) => resolve({ c, err })); p.stdin.end(); });
  check('--no-skills takes no value: a usage error (exit 2)', bad.c === 2 && /--no-skills/.test(bad.err), J(bad));

  // ---------------- the Worker ----------------
  const build = await imp('connector/build.js');
  const { createServer, MIME } = await imp('connector/worker/src/server.js');
  const views = build.views();
  const worker = createServer(views);
  const post = async (body, headers = {}) => {
    const r = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp', { method: 'POST', body: J(body), headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, headers) }));
    return { status: r.status, body: await r.json() };
  };
  // a 2026-07-28 request with the headers the HTTP binding requires
  const modern = (id, method, params = {}, extra = {}) => {
    const h = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method };
    if (method === 'resources/read') h['Mcp-Name'] = params.uri;
    if (method === 'tools/call') h['Mcp-Name'] = params.name;
    return post({ jsonrpc: '2.0', id, method, params: Object.assign({}, params, { _meta: META }) }, Object.assign(h, extra));
  };
  const wInitPlain = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const wInitAsks = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { extensions: { [EXT]: {} } }, clientInfo: { name: 't', version: '1' } } });
  check('Worker initialize, a client that does not declare the extension: exactly the capabilities it had (tools, resources, MCP Apps)',
    J(wInitPlain.body.result.capabilities) === J({ tools: { listChanged: false }, resources: { listChanged: false }, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] } } }) && !('resultType' in wInitPlain.body.result), J(wInitPlain.body.result.capabilities));
  check('Worker initialize, a client that declares it: MCP Apps and skills', J(wInitAsks.body.result.capabilities.extensions) === J({ 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] }, [EXT]: {} }), J(wInitAsks.body.result.capabilities));
  const wLegacyRes = await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  check('Worker resources/list on the handshake revisions: the two views, as before (no skill files)', J(wLegacyRes.body.result.resources.map((r) => r.uri)) === J(['ui://cloadm/panel.html', 'ui://cloadm/inline.html']) && !('resultType' in wLegacyRes.body.result), J(wLegacyRes.body));
  const wDisc = await modern(3, 'server/discover');
  const dc = wDisc.body.result && wDisc.body.result.capabilities;
  check('Worker server/discover: 200, tools, resources, MCP Apps and skills; the versions; the instructions; resultType and serverInfo',
    wDisc.status === 200 && !!dc && !!dc.tools && !!dc.resources && J(dc.extensions) === J({ 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] }, [EXT]: {} })
    && wDisc.body.result.supportedVersions[0] === MODERN && wDisc.body.result.supportedVersions.includes('2025-11-25') && wDisc.body.result.instructions === views.instructions
    && wDisc.body.result.resultType === 'complete' && wDisc.body.result._meta['io.modelcontextprotocol/serverInfo'].name === 'cloadm-panel', J(wDisc.body).slice(0, 500));
  const wList = await modern(4, 'skills/list');
  check('Worker skills/list: the cloadm skill, frontmatter and complete manifest as on disk', wList.status === 200 && wList.body.result.skills.length === 1 && goodSkill(wList.body.result.skills[0]) && wList.body.result.resultType === 'complete', J(wList.body).slice(0, 500));
  check('both servers list the same skill, manifest and all', J(wList.body.result.skills) === J(list.result.skills));
  const wGet = await modern(5, 'skills/get', { uri: 'skill://cloadm/SKILL.md' });
  check('Worker skills/get: the same entry', J(wGet.body.result.skill) === J(wList.body.result.skills[0]));
  const wBad = await allBytesSame(async (uri) => (await modern(6, 'resources/read', { uri })).body.result);
  check('Worker resources/read: every file in the manifest, byte for byte skills/cloadm/', wBad.length === 0, J(wBad));
  const wViews = await modern(7, 'resources/read', { uri: 'ui://cloadm/panel.html' });
  check('Worker resources/read on 2026-07-28: the views still, with their _meta', wViews.body.result.contents[0].text === views.site && !!wViews.body.result.contents[0]._meta.ui.csp && wViews.body.result.resultType === 'complete');
  const wRes = await modern(8, 'resources/list');
  check('Worker resources/list on 2026-07-28: the views and the skill files', J(wRes.body.result.resources.map((r) => r.uri)) === J(['ui://cloadm/panel.html', 'ui://cloadm/inline.html', ...WANT_MANIFEST.map((r) => r.uri)]), J(wRes.body).slice(0, 400));
  const wTools = await modern(9, 'tools/list');
  const wCall = await modern(10, 'tools/call', { name: 'open_emulator', arguments: {} });
  check('Worker tools on 2026-07-28: the two tools, and a call opens the view', wTools.body.result.tools.map((t) => t.name).join() === 'open_emulator,open_emulator_inline' && /opening in the view/.test(wCall.body.result.content[0].text) && wCall.body.result.resultType === 'complete', J(wCall.body).slice(0, 300));
  const wLegacySkills = await post({ jsonrpc: '2.0', id: 11, method: 'skills/list' });
  check('Worker skills/list on the handshake revisions (a client that declared the extension): the same skill, no 2026-07-28 fields', goodSkill(wLegacySkills.body.result.skills[0]) && !('resultType' in wLegacySkills.body.result) && !('_meta' in wLegacySkills.body.result), J(wLegacySkills.body).slice(0, 300));
  // errors
  const wUnknown = await modern(12, 'skills/get', { uri: 'skill://nope/SKILL.md' });
  const wFile = await modern(13, 'skills/get', { uri: 'skill://cloadm/references/hardware.md' });
  const wNoFile = await modern(14, 'resources/read', { uri: 'skill://cloadm/nope.md' });
  check('Worker errors: an unknown skill, a file URI to skills/get, an unknown file: -32602', [wUnknown, wFile, wNoFile].every((r) => r.status === 200 && r.body.error && r.body.error.code === -32602 && !r.body.result), J([wUnknown.body, wFile.body, wNoFile.body]));
  const h1 = await post({ jsonrpc: '2.0', id: 15, method: 'skills/list', params: { _meta: META } }, { 'Mcp-Method': 'skills/list' });
  const wrongMethod = await modern(16, 'skills/list', {}, { 'Mcp-Method': 'tools/list' });
  const wrongName = await modern(17, 'resources/read', { uri: 'skill://cloadm/SKILL.md' }, { 'Mcp-Name': 'skill://cloadm/references/hardware.md' });
  const noName = await post({ jsonrpc: '2.0', id: 18, method: 'resources/read', params: { uri: 'skill://cloadm/SKILL.md', _meta: META } }, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'resources/read' });
  const wrongVersionHeader = await modern(19, 'skills/list', {}, { 'MCP-Protocol-Version': '2025-11-25' });
  check('Worker 2026-07-28 headers: a missing MCP-Protocol-Version, Mcp-Method or Mcp-Name, or one that differs from the body: 400, HeaderMismatch -32020',
    [h1, wrongMethod, wrongName, noName, wrongVersionHeader].every((r) => r.status === 400 && r.body.error.code === -32020 && !r.body.result), J([h1.body, wrongMethod.body, wrongName.body, noName.body, wrongVersionHeader.body]));
  const b64 = await modern(20, 'resources/read', { uri: 'skill://cloadm/SKILL.md' }, { 'Mcp-Name': `=?base64?${Buffer.from('skill://cloadm/SKILL.md').toString('base64')}?=` });
  check('Worker 2026-07-28 headers: a Base64-encoded Mcp-Name is decoded before it is compared', b64.status === 200 && Buffer.from(b64.body.result.contents[0].text, 'utf8').equals(bytesOf('SKILL.md')), J(b64.body).slice(0, 200));
  const future = await post({ jsonrpc: '2.0', id: 21, method: 'skills/list', params: { _meta: Object.assign({}, META, { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) } }, { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'skills/list' });
  check('Worker: an unknown protocol version is 400 with UnsupportedProtocolVersionError -32022 and the versions it speaks',
    future.status === 400 && future.body.error.code === -32022 && future.body.error.data.requested === '2099-01-01' && J(future.body.error.data.supported) === J(wDisc.body.result.supportedVersions), J(future.body));
  const nope = await modern(22, 'prompts/list');
  const legacyNope = await post({ jsonrpc: '2.0', id: 23, method: 'prompts/list' });
  const modernInit = await modern(24, 'initialize', { protocolVersion: '2025-11-25' });
  check('Worker: an unknown method is 404 with -32601 on 2026-07-28 (initialize too), and 200 with -32601 on the handshake revisions, as before',
    nope.status === 404 && nope.body.error.code === -32601 && modernInit.status === 404 && legacyNope.status === 200 && legacyNope.body.error.code === -32601, J([nope, legacyNope, modernInit]));
  let refused = null;
  try { createServer(Object.assign({}, views, { skills: undefined })); } catch (e) { refused = e; }
  check('a Worker built from views without skills refuses to start', !!refused && /skills/.test(refused.message));

  // ---------------- the module's own checks ----------------
  const S = await imp('js/mcp/skills.js');
  const { loadSkill } = require(path.join(ROOT, 'cli', 'skill-files.js'));
  const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
  const mk = (name, files) => { const d = path.join(TMP, 'skills', name); fs.rmSync(d, { recursive: true, force: true }); for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), b); } return d; };
  check('frontmatter: plain and quoted scalars', J(S.frontmatter('---\nname: a\ndescription: "x: y"\nlicense: \'it\'\'s\'\n---\nbody')) === J({ name: 'a', description: 'x: y', license: 'it\'s' }));
  check('frontmatter: a nested map, a list, a block scalar, a duplicate key or no frontmatter is refused, not guessed at',
    ['---\nname: a\nmetadata:\n  k: v\n---\n', '---\nname: a\ntags: [a, b]\n---\n', '---\nname: a\ndescription: >\n  x\n---\n', '---\nname: a\nname: b\n---\n', '# no frontmatter\n']
      .every((t) => throws(() => S.frontmatter(t), /frontmatter/)));
  check('a skill whose SKILL.md names another skill is refused', throws(() => S.createSkillServer([loadSkill(mk('one', { 'SKILL.md': '---\nname: two\ndescription: d\n---\n' }))]), /named "two"/));
  check('a skill without SKILL.md, or without a description, is refused', throws(() => S.createSkillServer([loadSkill(mk('one', { 'README.md': 'x' }))]), /no SKILL\.md/)
    && throws(() => S.createSkillServer([loadSkill(mk('one', { 'SKILL.md': '---\nname: one\n---\n' }))]), /no description/));
  check('a file that is not UTF-8 text, or of a type this server does not serve, is refused', throws(() => loadSkill(mk('one', { 'SKILL.md': '---\nname: one\ndescription: d\n---\n', 'x.md': Buffer.from([0xff, 0xfe, 0x00]) })), /not UTF-8/)
    && throws(() => S.createSkillServer([loadSkill(mk('one', { 'SKILL.md': '---\nname: one\ndescription: d\n---\n', 'run.sh': 'echo' }))]), /not a text file/));
  const tiny = S.createSkillServer([loadSkill(mk('one', { 'SKILL.md': '---\nname: one\ndescription: d\n---\nhi\n' }))]);
  check('a hand-built skill: its manifest digest is the sha-256 of its bytes', tiny.list().skills[0].resources[0].digest === `sha256:${crypto.createHash('sha256').update('---\nname: one\ndescription: d\n---\nhi\n').digest('hex')}`);
})().catch((e) => { check('the MCP skills suite ran to the end', false, e.stack); }).finally(() => {
  for (const p of spawned) if (p.exitCode === null) p.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} MCP skills checks passed`);
  process.exitCode = fail ? 1 : 0;
});
