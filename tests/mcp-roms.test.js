// add_roms and remove_roms: the MCP server takes the user's own ROMs from the media root, an https URL or base64 data
// (js/mcp/tools.js, cli/rom-fetch.js, cli/rom-store.js, cli/mcp.js). Every ROM here is a stand-in built by this test
// (our own firmware, or filler bytes under a ROM's usual file name and size), never a real dump.
//  * url: a local https server with a CA made for this run and trusted only by this test's fetcher; refusals for http,
//    a user name in the URL, private, loopback, link-local and CGNAT addresses (literal, resolved, any one of several,
//    IPv4-mapped IPv6), a redirect into 127.0.0.1 or to a private name or to http, too many redirects, too large (by
//    Content-Length and by the body, and the tools' own cap), not a ROM, a timeout; no cookies or credentials sent; a
//    redirect or error with an endless body closed at once; a malformed %-escape in the name; the certificate checked
//    even with NODE_TLS_REJECT_UNAUTHORIZED=0;
//  * consent for a URL asked before anything is contacted, with the whole URL (query included);
//  * one cap on the bytes unpacked from all the ZIPs of a call; the store writing through no link;
//  * data (base64) and the media root (a file, a ZIP, a ROM pack, a folder; links and escapes refused);
//  * the consent paths: a confirm stub that accepts or declines, and over stdio a client that answers elicitation/create;
//  * the store: across a server restart, merged with --roms, list_models' sources, remove_roms; --read-only hides both;
//  * no ROM bytes in any result or in the server's stderr.
// Run: node tests/mcp-roms.test.js
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const Emu = require('./load')();
const M = require('../cli/mcp.js'), T = require('../js/mcp/tools.js'), { romStore } = require('../cli/rom-store.js'), { refusedAddress } = require('../cli/rom-fetch.js');

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-roms-')));
const tmp = (...p) => path.join(TMP, ...p);

// ---- stand-in ROMs ----
// the Dragon 64's BASIC socket: our own firmware (a loop), 16K, under the socket's usual name
const d64 = (() => {
  const r = Emu.assemble('        ORG $8000\nRESET   LDS #$7F00\nL       INC $3100\n        BRA L\n', '6809'), rom = new Uint8Array(0x4000).fill(0x12);
  rom.set(r.segments[0].data, 0); rom[0x3FFE] = 0x80; rom[0x3FFF] = 0;
  return rom;
})();
// the CoCo's Color BASIC socket: 8K of filler, a reset vector to $A000
const coco = (() => { const rom = new Uint8Array(0x2000).fill(0x12); rom[0x1FFE] = 0xA0; rom[0x1FFF] = 0; rom[0] = 0x20; rom[1] = 0xFE; return rom; })();
const ALL_ROMS = [d64, coco];
// a result (any JSON) holds none of these bytes: no base64 of any 24-byte run, no hex run of 12 bytes
const fingerprints = ALL_ROMS.flatMap((rom) => {
  const out = [];
  for (let at = 0; at + 24 <= rom.length; at += 997) {
    const run = Buffer.from(rom.subarray(at, at + 24));
    if (run.every((b) => b === run[0])) continue;   // filler: a run of one byte says nothing
    out.push(run.toString('base64').slice(0, 28), run.subarray(0, 12).toString('hex').toUpperCase(), [...run.subarray(0, 12)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
  }
  return out;
});
check('the stand-ins have runs to look for', fingerprints.length >= 6, String(fingerprints.length));
const leaks = (text) => fingerprints.filter((f) => text.includes(f) || text.toLowerCase().includes(f.toLowerCase()));
const results = [];   // every tool result, checked for ROM bytes at the end

// ---- a CA and a server certificate made for this run (openssl), trusted only by this test's fetcher ----
fs.mkdirSync(tmp('tls'));
const ssl = (...a) => execFileSync('openssl', a, { cwd: tmp('tls'), stdio: ['ignore', 'ignore', 'pipe'] });
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=cloadm test CA');
fs.writeFileSync(tmp('tls', 'ext.cnf'), 'subjectAltName=DNS:roms.test,DNS:mixed.test,DNS:other.test\nbasicConstraints=CA:FALSE\n');
ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=roms.test');
ssl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
const CA = fs.readFileSync(tmp('tls', 'ca.pem'));

// a response whose body never ends; closed[url] says when the client hung up
const closed = {};
function endless(s, status, headers) {
  const url = s.req.url;
  s.writeHead(status, Object.assign({ 'content-type': 'application/octet-stream' }, headers));
  const tick = setInterval(() => s.write(Buffer.alloc(16384, 0x41)), 5);
  s.on('close', () => { clearInterval(tick); closed[url] = Date.now(); });
}
// a ZIP whose entries are DEFLATE-compressed (Emu.writeZip stores them): small packed, large unpacked
function deflateZip(entries) {
  const locals = [], centrals = [];
  let at = 0;
  for (const [name, data] of entries) {
    const nm = Buffer.from(name), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034B50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014B50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(at, 42);
    locals.push(head, nm, comp); centrals.push(cen, nm);
    at += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const zipOf = (entries) => Emu.writeZip(entries.map(([name, data]) => ({ name, data })));
const seen = [];   // the headers of every request the test server got
let PORT;
const routes = {
  '/d64_1.rom': (q, s) => s.end(Buffer.from(d64)),
  '/files/bas13.rom': (q, s) => s.end(Buffer.from(coco)),
  '/roms.zip': (q, s) => s.end(Buffer.from(zipOf([['dragon/d64_1.rom', d64], ['bas13.rom', coco], ['readme.txt', new TextEncoder().encode('my dumps')]]))),
  '/redirect': (q, s) => { s.writeHead(302, { location: '/d64_1.rom', 'set-cookie': 'session=abc; Path=/' }); s.end(); },
  '/three': (q, s) => { s.writeHead(301, { location: '/two' }); s.end(); },
  '/two': (q, s) => { s.writeHead(307, { location: '/one' }); s.end(); },
  '/one': (q, s) => { s.writeHead(308, { location: '/d64_1.rom' }); s.end(); },
  '/four': (q, s) => { s.writeHead(302, { location: '/three' }); s.end(); },
  '/to-loopback': (q, s) => { s.writeHead(302, { location: `https://127.0.0.1:${PORT}/d64_1.rom` }); s.end(); },
  '/to-private': (q, s) => { s.writeHead(302, { location: `https://evil.test:${PORT}/d64_1.rom` }); s.end(); },
  '/to-http': (q, s) => { s.writeHead(302, { location: `http://roms.test:${PORT}/d64_1.rom` }); s.end(); },
  '/big.rom': (q, s) => s.end(Buffer.alloc((1 << 20) + 1, 0x39)),                       // over the file cap, under the ZIP cap
  '/huge.bin': (q, s) => s.end(Buffer.alloc((4 << 20) + 1, 0x39)),                      // over both: Content-Length
  '/stream.bin': (q, s) => { s.writeHead(200, { 'transfer-encoding': 'chunked' }); for (let i = 0; i < 5; i++) s.write(Buffer.alloc(1 << 20, 0x39)); s.end(); },
  '/notes.txt': (q, s) => s.end('not a ROM at all'),
  '/random.bin': (q, s) => s.end(Buffer.alloc(0x4000, 0x55)),                            // a ROM's size, nobody's name or contents
  '/slow.rom': () => { /* never answers */ },
  // a redirect, and an error, each with a body that never ends: the client must close them, not wait for the timer
  '/redirect-endless': (q, s) => endless(s, 302, { location: '/d64_1.rom' }),
  '/error-endless': (q, s) => endless(s, 500, {}),
  '/bad%E0%A4%A.rom': (q, s) => s.end(Buffer.from(d64)),
  '/gone.rom': (q, s) => { s.writeHead(404); s.end(); },
};
const srv = https.createServer({ key: fs.readFileSync(tmp('tls', 'srv.key')), cert: fs.readFileSync(tmp('tls', 'srv.pem')) }, (q, s) => {
  seen.push({ url: q.url, headers: q.headers });
  (routes[q.url.split('?')[0]] || ((x, y) => { y.writeHead(404); y.end(); }))(q, s);
});
// names the test resolves: public addresses (nothing is sent to them: every connection is dialled to the local test
// server), and refused ones
const NAMES = { 'roms.test': ['93.184.215.14'], 'other.test': ['2606:4700:4700::1111'], 'evil.test': ['10.0.0.5'], 'mixed.test': ['93.184.215.14', '127.0.0.1'], 'doc.test': ['203.0.113.10'], 'cgnat.test': ['100.64.3.4'], 'mapped.test': ['::ffff:127.0.0.1'], 'link.test': ['169.254.169.254'] };
const FETCH = { ca: CA, lookup: async (h) => { if (!NAMES[h]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); return NAMES[h]; }, dial: () => '127.0.0.1', timeoutMs: 1500 };

// an in-process toolbox over the Node host, with its own store and media root
function toolbox({ store = tmp('store'), roms = [], readOnly = false, fetch = FETCH, mediaRoot = tmp('media') } = {}) {
  const host = M.nodeHost({ mediaRoot, roms, png: () => new Uint8Array(0), romStore: romStore(store), fetch });
  const tb = T.createToolbox(host, { readOnly });
  return {
    tb, host,
    async call(name, args, ctx = {}) { const r = await tb.call(name, args, ctx); results.push(J(r)); return r; },
  };
}
const code = (r) => (r.ok ? 'ok' : r.error.code);
const model = (r, id) => r.data.models.find((m) => m.id === id);

// media: ROMs in a folder, with a link out of the root and a file past the cap
fs.mkdirSync(tmp('media', 'dumps', 'more'), { recursive: true });
fs.mkdirSync(tmp('outside'));
fs.writeFileSync(tmp('media', 'dumps', 'd64_1.rom'), d64);
fs.writeFileSync(tmp('media', 'dumps', 'more', 'bas13.rom'), coco);
fs.writeFileSync(tmp('media', 'dumps', 'letter.txt'), 'dear diary');
fs.writeFileSync(tmp('outside', 'extbas11.rom'), new Uint8Array(0x2000).fill(7));
fs.symlinkSync(tmp('outside', 'extbas11.rom'), tmp('media', 'dumps', 'extbas11.rom'));
fs.writeFileSync(tmp('media', 'dumps', 'huge.rom'), '');
fs.truncateSync(tmp('media', 'dumps', 'huge.rom'), (4 << 20) + 1);
fs.writeFileSync(tmp('media', 'single.rom'), d64);   // not a usual name: not recognised by name; by contents neither
fs.writeFileSync(tmp('media', 'd64_1.rom'), d64);
fs.writeFileSync(tmp('media', 'pack.zip'), zipOf(Emu.makeRomPack({ sockets: () => [{ owner: 'coco', socket: 'bas', crc: Emu.crc32(coco) }], image: () => coco }).entries.map((e) => [e.name, e.data])));

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  PORT = srv.address().port;
  const U = (p, h = 'roms.test') => `https://${h}:${PORT}${p}`;

  // ---------------- the address check ----------------
  const refused = ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '100.64.0.1', '100.127.255.255', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1',
    '192.0.2.1', '198.51.100.7', '203.0.113.10', '192.88.99.1', '198.18.0.1', '2001:db8::10', '64:ff9b:1::1', '2001:0:4136:e378::1', '::ffff:8.8.8.8', '::ffff:0:0'];
  const allowed = ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.3.1', '203.0.114.1', '2606:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '2001:4860::1'];
  check('the address check: loopback, link-local, private, CGNAT, unspecified, multicast and embedded-IPv4 forms refused', refused.every((a) => refusedAddress(a)), refused.filter((a) => !refusedAddress(a)).join());
  check('the address check: public addresses (also next to the refused ranges) allowed', allowed.every((a) => refusedAddress(a) === null), allowed.filter((a) => refusedAddress(a)).join());

  // ---------------- url ----------------
  {
    const t = toolbox({ store: tmp('store-url') });
    const before = await t.call('list_models', {});
    check('before: no model has BASIC, no ROM loaded', before.data.models.every((m) => !m.basic && m.roms.every((r) => r.loaded === null)), J(model(before, 'dragon64')));
    const ok = await t.call('add_roms', { source: 'url', url: U('/d64_1.rom') });
    check('url: a stand-in Dragon 64 BASIC ROM fetched over https (test CA) and stored', ok.ok && ok.data.added.length === 1 && ok.data.added[0].name === 'd64_1.rom' && ok.data.added[0].size === 0x4000
      && ok.data.models_with_basic.includes('dragon64') && ok.data.newly_with_basic.includes('dragon64') && /boot/.test(ok.data.next), J(ok));
    check('url: without a confirm the result says the person was not asked', ok.ok && /not asked/.test(ok.data.consent), J(ok.data && ok.data.consent));
    const after = await t.call('list_models', {});
    const d = model(after, 'dragon64');
    check('list_models: the Dragon 64 has BASIC now, its ROM from the store', d.basic === true && d.roms[0].loaded && d.roms[0].loaded.file === 'd64_1.rom' && d.roms[0].loaded.source === 'stored', J(d));
    const boot = await t.call('boot', { model: 'dragon64' });
    check('a machine booted afterwards runs the stored ROM', boot.ok && boot.data.machine.roms === true, J(boot));
    const redir = await t.call('add_roms', { source: 'url', url: U('/redirect') });
    check('url: a redirect on the same public host is followed', redir.ok && redir.data.added[0].name === 'd64_1.rom', J(redir));
    const three = await t.call('add_roms', { source: 'url', url: U('/three') });
    check('url: three redirects are followed', three.ok, J(three));
    const four = await t.call('add_roms', { source: 'url', url: U('/four') });
    check('url: a fourth redirect is refused (refused-url)', code(four) === 'refused-url' && /more than 3 redirects/.test(four.error.detail), J(four));
    const fetched = seen.filter((x) => x.url === '/d64_1.rom');
    check('url: no cookie (not even one the server set on a redirect) and no credentials are sent', seen.length > 3 && seen.every((x) => !x.headers.cookie && !x.headers.authorization && !x.headers['proxy-authorization']) && fetched.length >= 3, J(seen.map((x) => x.headers)));
    const zip = await t.call('add_roms', { source: 'url', url: U('/roms.zip') });
    check('url: a ZIP of ROMs: each ROM in it stored, the rest skipped as not a ROM', zip.ok && J(zip.data.added.map((a) => a.name).sort()) === J(['bas13.rom', 'd64_1.rom']) && zip.data.skipped.some((x) => x.name === 'readme.txt' && x.why === 'not-a-rom')
      && zip.data.models_with_basic.includes('coco'), J(zip));
    const named = await t.call('add_roms', { source: 'url', url: U('/files/bas13.rom', 'other.test') });
    check('url: a host resolving to a public IPv6 address', named.ok, J(named));

    const cases = [
      ['http', `http://roms.test:${PORT}/d64_1.rom`, 'refused-url', /not https/],
      ['a user name and password in the URL', `https://me:secret@roms.test:${PORT}/d64_1.rom`, 'refused-url', /user name or password/],
      ['a literal loopback address', `https://127.0.0.1:${PORT}/d64_1.rom`, 'refused-url', /loopback/],
      ['a literal private address', 'https://10.1.2.3/d64_1.rom', 'refused-url', /private/],
      ['a literal IPv6 loopback', `https://[::1]:${PORT}/d64_1.rom`, 'refused-url', /loopback/],
      ['a name resolving to a private address', U('/d64_1.rom', 'evil.test'), 'refused-url', /10\.0\.0\.5, a private/],
      ['a name with a public and a loopback address', U('/d64_1.rom', 'mixed.test'), 'refused-url', /127\.0\.0\.1, a loopback/],
      ['a name resolving to CGNAT', U('/d64_1.rom', 'cgnat.test'), 'refused-url', /CGNAT/],
      ['a name resolving to an IPv4-mapped loopback', U('/d64_1.rom', 'mapped.test'), 'refused-url', /::ffff:127\.0\.0\.1, an IPv4-mapped/],
      ['a name resolving to link-local (cloud metadata)', U('/d64_1.rom', 'link.test'), 'refused-url', /link-local/],
      ['a name resolving to a documentation address', U('/d64_1.rom', 'doc.test'), 'refused-url', /documentation/],
      ['a literal IPv4-mapped IPv6 address', `https://[::ffff:8.8.8.8]:${PORT}/d64_1.rom`, 'refused-url', /IPv4-mapped/],
      ['an error status with a body that never ends: closed at once', U('/error-endless'), 'fetch-failed', /HTTP 500/],
      ['a malformed %-escape in the file name: the raw name, not a failure', U('/bad%E0%A4%A.rom'), 'not-a-rom', /bad%E0%A4%A\.rom/],
      ['a redirect into 127.0.0.1', U('/to-loopback'), 'refused-url', /127\.0\.0\.1.*loopback.*redirect/],
      ['a redirect to a name resolving privately', U('/to-private'), 'refused-url', /private.*redirect/],
      ['a redirect to http', U('/to-http'), 'refused-url', /not https \(a redirect\)/],
      ['a file over 1 MiB (not a ZIP)', U('/big.rom'), 'too-large', /1048577 bytes, at most 1048576/],
      ['over 4 MiB by its Content-Length', U('/huge.bin'), 'too-large', /4194305 bytes, at most 4194304/],
      ['over 4 MiB by its body (no Content-Length)', U('/stream.bin'), 'too-large', /more than 4194304 bytes/],
      ['not a ROM (text)', U('/notes.txt'), 'not-a-rom', /notes\.txt/],
      ['not a ROM (a ROM\'s size, unknown name and contents)', U('/random.bin'), 'not-a-rom', /random\.bin/],
      ['a server that never answers: the timeout', U('/slow.rom'), 'fetch-failed', /timed out after 2 s/],
      ['HTTP 404', U('/gone.rom'), 'fetch-failed', /HTTP 404/],
      ['a name that does not resolve', U('/d64_1.rom', 'nowhere.test'), 'fetch-failed', /ENOTFOUND/],
    ];
    const t2 = toolbox({ store: tmp('store-refusals') });
    for (const [what, url, want, re] of cases) {
      const r = await t2.call('add_roms', { source: 'url', url });
      check(`url refused: ${what} -> ${want}`, code(r) === want && re.test(r.error.detail || ''), J(r));
    }
    check('url refusals stored nothing', t2.host.storedRoms().filter((x) => x.name !== 'd64_1.rom').length === 0 && t2.host.storedRoms().length <= 1 && !fs.existsSync(tmp('store-refusals', 'index.json')), J(t2.host.storedRoms()));
    check('url: the default timeout is 20 s and the redirect limit 3', require('../cli/rom-fetch.js').TIMEOUT_MS === 20000 && require('../cli/rom-fetch.js').MAX_REDIRECTS === 3);
    // a URL with no test CA: the system trust store does not know this server's CA
    const t3 = toolbox({ store: tmp('store-noca'), fetch: Object.assign({}, FETCH, { ca: undefined }) });
    const untrusted = await t3.call('add_roms', { source: 'url', url: U('/d64_1.rom') });
    check('url: a certificate the trust store does not know is refused (fetch-failed)', code(untrusted) === 'fetch-failed', J(untrusted));
    // NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off for every request that does not set it: this one does
    const was = process.env.NODE_TLS_REJECT_UNAUTHORIZED, warn = process.emitWarning;
    process.emitWarning = () => {};
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const stillChecked = await t3.call('add_roms', { source: 'url', url: U('/d64_1.rom') });
    if (was === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = was;
    process.emitWarning = warn;
    check('url: the certificate is checked even with NODE_TLS_REJECT_UNAUTHORIZED=0 (rejectUnauthorized set)', code(stillChecked) === 'fetch-failed' && /CERT|SIGNATURE|ISSUER|self.signed/i.test(stillChecked.error.detail), J(stillChecked));
    // a redirect with a body that never ends: followed at once, and the redirect's connection closed by the client
    const t0 = Date.now();
    const endlessRedirect = await t2.call('add_roms', { source: 'url', url: U('/redirect-endless') });
    await new Promise((r) => setTimeout(r, 300));
    check('url: a redirect whose body never ends is followed and its connection closed at once, well before the timeout',
      endlessRedirect.ok && Date.now() - t0 < 1200 && closed['/redirect-endless'] && closed['/redirect-endless'] - t0 < 1000 && closed['/error-endless'], J([endlessRedirect.ok, closed]));
    const cancel = new AbortController();
    const tc = toolbox({ store: tmp('store-cancel') });
    const pending = tc.tb.call('add_roms', { source: 'url', url: U('/slow.rom') }, { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 100);
    const cancelled = await pending;
    check('url: a cancelled call stops the download (cancelled)', code(cancelled) === 'cancelled', J(cancelled));
  }

  // ---------------- data ----------------
  {
    const t = toolbox({ store: tmp('store-data') });
    const b64 = Buffer.from(coco).toString('base64');
    const ok = await t.call('add_roms', { source: 'data', data: b64, name: 'bas13.rom' });
    check('data: base64 bytes of an upload, matched by its usual name and size', ok.ok && ok.data.added[0].name === 'bas13.rom' && ok.data.newly_with_basic.includes('coco'), J(ok));
    const wrapped = await t.call('add_roms', { source: 'data', data: b64.replace(/(.{76})/g, '$1\n'), name: 'C:\\dumps\\bas13.rom' });
    check('data: line breaks in the base64 and a path in the name are fine (the base name is kept)', wrapped.ok && wrapped.data.added[0].name === 'bas13.rom', J(wrapped));
    const big = await t.call('add_roms', { source: 'data', data: Buffer.alloc((1 << 20) + 1, 1).toString('base64'), name: 'big.rom' });
    check('data: over 1 MiB -> too-large', code(big) === 'too-large', J(big));
    const huge = await t.call('add_roms', { source: 'data', data: 'A'.repeat(6 << 20), name: 'huge.zip' });
    check('data: over 4 MiB -> too-large, not decoded', code(huge) === 'too-large' && /at most 4194304/.test(huge.error.detail), J(huge));
    const junk = await t.call('add_roms', { source: 'data', data: Buffer.from('hello there').toString('base64'), name: 'hello.txt' });
    check('data: not a ROM -> not-a-rom, nothing stored', code(junk) === 'not-a-rom' && t.host.storedRoms().length === 1, J(junk));
    const bad = await t.call('add_roms', { source: 'data', data: 'not base64!', name: 'x.rom' });
    const noName = await t.call('add_roms', { source: 'data', data: b64 });
    const mixed = await t.call('add_roms', { source: 'data', data: b64, name: 'bas13.rom', url: 'https://x.test/a' });
    const noSource = await t.call('add_roms', { data: b64, name: 'bas13.rom' });
    check('data: bad base64, a missing name, an argument of another source, no source: bad-argument', [bad, noName, mixed, noSource].every((r) => code(r) === 'bad-argument'), J([bad, noName, mixed, noSource].map((r) => r.error)));
    // ten 1 MiB entries of zeros: a few KB packed, 10 MiB unpacked, over the 8 MiB a call may unpack
    const bomb = deflateZip([...Array(10)].map((_, i) => [`x${i}.rom`, new Uint8Array(1 << 20)]));
    const bombR = await t.call('add_roms', { source: 'data', data: Buffer.from(bomb).toString('base64'), name: 'bomb.zip' });
    check('data: ZIPs unpacking past 8 MiB in all -> too-large (the packed file is small)', bomb.length < 65536 && code(bombR) === 'too-large' && /unpacked in all/.test(bombR.error.detail), `${bomb.length} bytes; ${J(bombR)}`);
    const small = deflateZip([['bas13.rom', coco], ['pad.bin', new Uint8Array(1 << 20)]]);
    const smallR = await t.call('add_roms', { source: 'data', data: Buffer.from(small).toString('base64'), name: 'small.zip' });
    check('data: a DEFLATE ZIP under the cap is opened', smallR.ok && smallR.data.added[0].name === 'bas13.rom', J(smallR));
    const pack = zipOf(Emu.makeRomPack({ sockets: () => [{ owner: 'dragon64', socket: 'basic', crc: Emu.crc32(d64) }], image: () => d64 }).entries.map((e) => [e.name, e.data]));
    const packR = await t.call('add_roms', { source: 'data', data: Buffer.from(pack).toString('base64'), name: 'cloadm-roms.zip' });
    check('data: a ROM pack goes back to the socket its manifest names, under that socket\'s file name', packR.ok && packR.data.added[0].name === 'd64_1.rom' && packR.data.newly_with_basic.includes('dragon64'), J(packR));
  }

  // ---------------- media ----------------
  {
    const t = toolbox({ store: tmp('store-media') });
    const folder = await t.call('add_roms', { source: 'media', path: 'dumps' });
    const skipped = folder.ok ? folder.data.skipped.map((x) => `${x.name}:${x.why}`).sort() : [];
    check('media: a folder: its ROMs (also in a subfolder) stored; text, the file past the cap and the link out of the root not', folder.ok && J(folder.data.added.map((a) => a.name).sort()) === J(['bas13.rom', 'd64_1.rom'])
      && J(skipped) === J(['huge.rom:too-large', 'letter.txt:not-a-rom']) && !folder.data.added.some((a) => a.name === 'extbas11.rom'), J(folder));
    const file = await t.call('add_roms', { source: 'media', path: 'd64_1.rom' });
    check('media: one file', file.ok && file.data.added.length === 1, J(file));
    const packR = await t.call('add_roms', { source: 'media', path: 'pack.zip' });
    check('media: a ROM pack from the media root', packR.ok && packR.data.added[0].name === 'bas12.rom', J(packR));
    const unknown = await t.call('add_roms', { source: 'media', path: 'single.rom' });
    check('media: a file nothing recognises -> not-a-rom', code(unknown) === 'not-a-rom', J(unknown));
    const out = await t.call('add_roms', { source: 'media', path: '../outside' });
    const link = await t.call('add_roms', { source: 'media', path: 'dumps/extbas11.rom' });
    const abs = await t.call('add_roms', { source: 'media', path: tmp('outside', 'extbas11.rom') });
    check('media: paths out of the root (.., a link, an absolute path) -> outside-media-root', [out, link, abs].every((r) => code(r) === 'outside-media-root'), J([out, link, abs].map((r) => r.error)));
    const missing = await t.call('add_roms', { source: 'media', path: 'nope.rom' });
    check('media: a missing file -> cannot-read', code(missing) === 'cannot-read', J(missing));
    const noRoot = toolbox({ store: tmp('store-noroot'), mediaRoot: null });
    const nr = await noRoot.call('add_roms', { source: 'media', path: 'dumps' });
    check('media: no media root -> no-media-root', code(nr) === 'no-media-root', J(nr));
  }

  // ---------------- consent (a confirm stub) ----------------
  {
    const t = toolbox({ store: tmp('store-consent') });
    const asked = [], lookups = [];
    // a URL that would carry data out in its query: the person sees all of it, and nothing is contacted (not even DNS)
    // unless they say yes
    const probe = U('/d64_1.rom?session=s3cr3t&user=me%40example.org');
    const tp = toolbox({ store: tmp('store-probe'), fetch: Object.assign({}, FETCH, { lookup: async (h) => { lookups.push(h); return FETCH.lookup(h); } }) });
    const before = seen.length;
    const declined = await tp.call('add_roms', { source: 'url', url: probe }, { confirm: async (msg) => { asked.push(msg); return 'decline'; } });
    check('consent (url): asked first, with the whole URL, query included', asked.length === 1 && asked[0].includes(probe) && /^Download /.test(asked[0]), J(asked));
    check('consent (url): a decline contacts nothing: no request reached the server and no name was looked up', code(declined) === 'declined' && seen.length === before && lookups.length === 0
      && !seen.some((x) => /s3cr3t/.test(x.url)) && tp.host.storedRoms().length === 0, J([declined, seen.length - before, lookups]));
    const refusedFirst = await tp.call('add_roms', { source: 'url', url: 'https://10.9.9.9/x.rom?leak=1' }, { confirm: async (msg) => { asked.push(msg); return 'accept'; } });
    check('consent (url): a URL refused without the network (a literal private address) is refused before anyone is asked', code(refusedFirst) === 'refused-url' && asked.length === 1, J(refusedFirst));
    const okProbe = await tp.call('add_roms', { source: 'url', url: probe }, { confirm: async (msg) => { asked.push(msg); return 'accept'; } });
    check('consent (url): an accept downloads and stores, asking once only', okProbe.ok && asked.length === 2 && seen.length === before + 1 && seen[seen.length - 1].url === '/d64_1.rom?session=s3cr3t&user=me%40example.org', J(okProbe));
    const askedData = [];
    const declinedData = await t.call('add_roms', { source: 'data', data: Buffer.from(d64).toString('base64'), name: 'd64_1.rom' }, { confirm: async (msg) => { askedData.push(msg); return 'decline'; } });
    check('consent (upload): asked with the source, the files and the models', askedData.length === 1 && /^Add these ROMs from an upload \(d64_1\.rom\): d64_1\.rom → .*Dragon 64/.test(askedData[0]), J(askedData));
    check('consent: a decline stores nothing (declined)', code(declinedData) === 'declined' && t.host.storedRoms().length === 0 && !model(await t.call('list_models', {}), 'dragon64').basic, J(declinedData));
    const cancelled = await t.call('add_roms', { source: 'data', data: Buffer.from(coco).toString('base64'), name: 'bas13.rom' }, { confirm: async () => 'cancel' });
    check('consent: a cancel stores nothing', code(cancelled) === 'declined' && t.host.storedRoms().length === 0, J(cancelled));
    const accepted = await t.call('add_roms', { source: 'url', url: U('/d64_1.rom') }, { confirm: async () => 'accept' });
    check('consent: an accept stores them, and the result says the person confirmed', accepted.ok && /confirmed/.test(accepted.data.consent) && t.host.storedRoms().length === 1, J(accepted));
    let notAsked = 0;
    const nothing = await t.call('add_roms', { source: 'data', data: Buffer.from('not a rom').toString('base64'), name: 'notes.txt' }, { confirm: async () => { notAsked++; return 'accept'; } });
    check('consent: nothing to store from an upload, nobody asked', code(nothing) === 'not-a-rom' && notAsked === 0);
  }

  // ---------------- remove_roms, sources, merging with --roms ----------------
  {
    const t = toolbox({ store: tmp('store-remove'), roms: [{ name: 'd64_1.rom', bytes: d64, source: 'cli' }] });
    await t.call('add_roms', { source: 'data', data: Buffer.from(coco).toString('base64'), name: 'bas13.rom' });
    const again = await t.call('add_roms', { source: 'data', data: Buffer.from(d64).toString('base64'), name: 'd64_1.rom' });
    const lm = await t.call('list_models', {});
    check('list_models: each ROM\'s source (cli for --roms, stored for add_roms); a stored copy of a --roms ROM shows as cli', again.ok && model(lm, 'dragon64').roms[0].loaded.source === 'cli' && model(lm, 'coco').roms[0].loaded.source === 'stored' && model(lm, 'coco').basic, J([model(lm, 'dragon64').roms, model(lm, 'coco').roms]));
    const unknown = await t.call('remove_roms', { names: ['nope.rom'] });
    check('remove_roms: an unknown name -> bad-argument naming what is stored', code(unknown) === 'bad-argument' && /bas13\.rom/.test(unknown.error.detail), J(unknown));
    const both = await t.call('remove_roms', { names: ['bas13.rom'], all: true }), none = await t.call('remove_roms', {});
    check('remove_roms: names or all, one of them', code(both) === 'bad-argument' && code(none) === 'bad-argument');
    const rm = await t.call('remove_roms', { names: ['bas13.rom'] });
    check('remove_roms: forgets the stored ROM; the --roms one stays', rm.ok && J(rm.data.removed) === J(['bas13.rom']) && !rm.data.models_with_basic.includes('coco') && rm.data.models_with_basic.includes('dragon64'), J(rm));
    const all = await t.call('remove_roms', { all: true });
    check('remove_roms all: the store is empty, its image files gone', all.ok && t.host.storedRoms().length === 0 && fs.readdirSync(tmp('store-remove')).filter((f) => f.endsWith('.rom')).length === 0, J(all));
    // the store writes a new file and renames it into place: a link planted at an image's name is replaced, not followed
    const victim = tmp('outside', 'victim.txt'), crcName = Emu.crc32(coco) + '.rom';
    fs.writeFileSync(victim, 'keep me');
    fs.mkdirSync(tmp('store-link'), { recursive: true });
    fs.symlinkSync(victim, tmp('store-link', crcName));
    const tl = toolbox({ store: tmp('store-link') });
    const linked = await tl.call('add_roms', { source: 'data', data: Buffer.from(coco).toString('base64'), name: 'bas13.rom' });
    check('store: a link at the image\'s name is replaced, never written through', linked.ok && fs.readFileSync(victim, 'utf8') === 'keep me' && !fs.lstatSync(tmp('store-link', crcName)).isSymbolicLink()
      && fs.readdirSync(tmp('store-link')).every((f) => !f.endsWith('.tmp')), J(linked));
    const noStore = T.createToolbox(M.nodeHost({ mediaRoot: null, roms: [], png: () => null }), {});
    const ns = await noStore.call('add_roms', { source: 'data', data: 'AAAA', name: 'x.rom' });
    check('a host without a ROM store: no-rom-store', ns.error && ns.error.code === 'no-rom-store', J(ns));
  }

  // ---------------- the stdio server: restart, read-only, elicitation ----------------
  const HOME = tmp('home');
  fs.mkdirSync(HOME);
  const ENV = Object.assign({}, process.env, { HOME, APPDATA: path.join(HOME, 'AppData') });
  const stderrs = [];
  function server(args = []) {
    const p = spawn(process.execPath, [CLI, '--mcp', '--media-root', tmp('media'), ...args], { cwd: ROOT, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const got = [], waiters = [];
    let buf = '', stderr = '', id = 0;
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        got.push(msg);
        results.push(J(msg));
        for (const w of waiters.slice()) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      }
    });
    p.stderr.on('data', (d) => { stderr += d; });
    const api = {
      got,
      send: (m) => p.stdin.write(J(Object.assign({ jsonrpc: '2.0' }, m)) + '\n'),
      wait: (test) => new Promise((resolve, reject) => {
        const hit = got.find(test);
        if (hit) { resolve(hit); return; }
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error(`no reply; stderr ${stderr.slice(-300)}`)), 30000).unref();
      }),
      request: (method, params) => { const rid = ++id; api.send({ id: rid, method, params }); return api.wait((m) => m.id === rid); },
      init: (capabilities = {}) => api.request('initialize', { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'roms.test', version: '1' } }),
      call: async (name, args) => { const r = await api.request('tools/call', { name, arguments: args }); return JSON.parse(r.result.content[0].text); },
      close: () => new Promise((resolve) => { p.on('close', () => { stderrs.push(stderr); resolve(stderr); }); p.stdin.end(); }),
    };
    return api;
  }
  {
    const s = server();
    await s.init();
    const added = await s.call('add_roms', { source: 'data', data: Buffer.from(d64).toString('base64'), name: 'd64_1.rom' });
    check('server: add_roms stores into the store next to the config file', !added.error && fs.existsSync(path.join(HOME, '.config', 'cloadm', 'roms', 'index.json')), J(added));
    await s.close();
    const s2 = server();
    await s2.init();
    const lm = await s2.call('list_models', {});
    const d = lm.models.find((m) => m.id === 'dragon64');
    check('server restarted: the stored ROM is still there (source stored)', d.basic && d.roms[0].loaded.source === 'stored', J(d));
    const boot = await s2.call('boot', { model: 'dragon64', roms: true });
    check('server restarted: a Dragon 64 boots the stored ROM', boot.machine && boot.machine.roms === true, J(boot));
    // a machine open before add_roms does not change
    const cocoBefore = await s2.call('boot', { model: 'coco' });
    await s2.call('add_roms', { source: 'data', data: Buffer.from(coco).toString('base64'), name: 'bas13.rom' });
    const machines = await s2.call('list_machines', {});
    const cocoAfter = await s2.call('boot', { model: 'coco' });
    check('a machine already open keeps its firmware; one booted after has the new ROM', cocoBefore.machine.roms === false && machines.machines.find((m) => m.machine_id === cocoBefore.machine.machine_id).roms === false && cocoAfter.machine.roms === true, J([cocoBefore.machine, cocoAfter.machine]));
    await s2.close();
    // --roms on the command line is merged with the store
    fs.mkdirSync(tmp('cli-roms'));
    fs.writeFileSync(tmp('cli-roms', 'extbas11.rom'), new Uint8Array(0x2000).fill(0x39));
    const s3 = server(['--roms', tmp('cli-roms')]);
    await s3.init();
    const c = (await s3.call('list_models', {})).models.find((m) => m.id === 'coco');
    check('server: --roms and the store merged; list_models gives each one\'s source', c.basic && c.roms[0].loaded.source === 'stored' && c.roms[1].loaded.source === 'cli', J(c.roms));
    await s3.close();

    // --read-only: neither tool offered; a call refused; the stored ROMs still boot
    const r = server(['--read-only']);
    await r.init();
    const names = (await r.request('tools/list', {})).result.tools.map((t) => t.name);
    const refusedCall = await r.call('add_roms', { source: 'data', data: Buffer.from(coco).toString('base64'), name: 'bas13.rom' });
    const refusedRm = await r.call('remove_roms', { all: true });
    const rlm = (await r.call('list_models', {})).models.find((m) => m.id === 'dragon64');
    check('--read-only: add_roms and remove_roms are not offered and are refused (read-only); stored ROMs still count', !names.includes('add_roms') && !names.includes('remove_roms') && refusedCall.error.code === 'read-only' && refusedRm.error.code === 'read-only' && rlm.basic, J([names.length, refusedCall, refusedRm]));
    await r.close();

    // elicitation: a client that takes them is asked; its answer decides
    const e = server();
    await e.init({ elicitation: {} });
    const rid = 900;
    e.send({ id: rid, method: 'tools/call', params: { name: 'add_roms', arguments: { source: 'url', url: 'https://10.9.9.9/x.rom' } } });
    const notAsked = await e.wait((m) => m.id === rid);
    check('elicitation: a refused URL fails before anyone is asked', JSON.parse(notAsked.result.content[0].text).error.code === 'refused-url' && !e.got.some((m) => m.method === 'elicitation/create'), J(notAsked));
    e.send({ id: 901, method: 'tools/call', params: { name: 'add_roms', arguments: { source: 'media', path: 'dumps/more/bas13.rom' } } });
    const ask = await e.wait((m) => m.method === 'elicitation/create');
    check('elicitation: elicitation/create with the message and an object schema', /^Add these ROMs from the media root \(dumps\/more\/bas13\.rom\): bas13\.rom → .*CoCo/.test(ask.params.message) && ask.params.requestedSchema.type === 'object' && ask.id != null, J(ask));
    e.send({ id: ask.id, result: { action: 'decline' } });
    const dec = JSON.parse((await e.wait((m) => m.id === 901)).result.content[0].text);
    check('elicitation: decline -> declined, nothing stored', dec.error && dec.error.code === 'declined' && (await e.call('remove_roms', { names: ['bas13.rom'] })).removed.length === 1, J(dec));
    // (bas13.rom from the earlier server was there; it is gone now, and the decline did not put it back)
    e.send({ id: 902, method: 'tools/call', params: { name: 'add_roms', arguments: { source: 'media', path: 'dumps/more/bas13.rom' } } });
    const ask2 = await e.wait((m) => m.method === 'elicitation/create' && m.id !== ask.id);
    e.send({ id: ask2.id, error: { code: -32603, message: 'the client could not ask' } });
    const err = JSON.parse((await e.wait((m) => m.id === 902)).result.content[0].text);
    check('elicitation: an error reply counts as a decline', err.error && err.error.code === 'declined', J(err));
    e.send({ id: 903, method: 'tools/call', params: { name: 'add_roms', arguments: { source: 'media', path: 'dumps/more/bas13.rom' } } });
    const ask3 = await e.wait((m) => m.method === 'elicitation/create' && ![ask.id, ask2.id].includes(m.id));
    e.send({ id: ask3.id, result: { action: 'accept', content: {} } });
    const acc = JSON.parse((await e.wait((m) => m.id === 903)).result.content[0].text);
    const elm = (await e.call('list_models', {})).models.find((m) => m.id === 'coco');
    check('elicitation: accept -> stored, and list_models has it', !acc.error && /confirmed/.test(acc.consent) && elm.basic && elm.roms[0].loaded.source === 'stored', J(acc));
    await e.close();
    // a client without elicitation is not sent one
    const q = server();
    await q.init({});
    const quiet = await q.call('add_roms', { source: 'media', path: 'dumps/d64_1.rom' });
    check('no elicitation capability: no elicitation/create sent; the result says so', !q.got.some((m) => m.method === 'elicitation/create') && /not asked/.test(quiet.consent), J(quiet));
    await q.close();
  }

  // ---------------- no ROM bytes anywhere ----------------
  const leaked = results.map((r) => leaks(r)).filter((l) => l.length);
  check('no ROM bytes in any tool result (base64 or hex) of this run', results.length > 50 && !leaked.length, `${results.length} results; ${J(leaked.slice(0, 2))}`);
  check('no ROM bytes in the server\'s stderr', stderrs.length >= 5 && stderrs.every((e) => !leaks(e).length), J(stderrs.map((e) => e.slice(0, 200))));

  srv.closeAllConnections();
  srv.close();
  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite ran to the end', e); srv.closeAllConnections(); srv.close(); process.exitCode = 1; });
