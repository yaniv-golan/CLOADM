// The short-link Worker (shortlink/worker.js), run in Node against an in-memory R2 bucket and stand-in rate limiters
// (the bindings a deployment configures: docs/shortlink-deploy.md). Nothing here reaches Cloudflare.
//  * making a link: the three objects, the sealed bytes as sent, the arrival page from its fixed template (its script
//    allowed by the hash in its CSP, worked out here; only the id and the machine's name in it; Report this link)
//  * every refusal: origin, kill switch (existing links stay), per-address, global and daily limits, sizes, malformed
//    requests, every way a picture can be wrong
//  * delete by token (wrong token refused, stored as a hash only), counts kept under concurrent writes, the public
//    totals page, and no address stored anywhere
//  * the Worker and the page agree: newLinkBody is what the Worker reads; the machines and the limits are the page's
const zlib = require('zlib');
const Emu = require('./load')();
const W = require('../shortlink/worker.js');
const worker = W.default;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const { MemoryBucket: Bucket, memoryLimiter: limiter } = require('../shortlink/memory-bucket.js');
const envOf = (over = {}) => Object.assign({ BUCKET: new Bucket(), RATE_IP: limiter(100), RATE_ALL: limiter(1000), DAILY_CAP: '100', ALLOWED_ORIGINS: 'https://cloadm.dev', REPORT_EMAIL: 'abuse@example.com' }, over);
const ORIGIN = 'https://cloadm.dev', IP = '203.0.113.77';
const req = (path, { method = 'POST', body = null, origin = ORIGIN, ip = IP, type = 'application/octet-stream' } = {}) => new Request(`https://s.cloadm.dev${path}`, {
  method, body, headers: Object.assign({ 'CF-Connecting-IP': ip, 'Content-Type': type }, origin ? { Origin: origin } : {}) });
const call = (env, r, now = new Date('2026-11-24T10:00:00Z')) => worker.fetch(r, env, {}, now);
const sealed = (n = 3000, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xFF);

(async () => {
  const card = async () => { const f = new Emu.Frame(320, 240, 4 / 3, { x: 32, y: 24, width: 256, height: 192 }); f.table[0] = Emu.rgb(0, 0, 0); f.table[1] = Emu.rgb(40, 200, 40); for (let i = 0; i < f.data.length; i += 7) f.data[i] = 1; return Emu.encodeIndexedPng(Emu.cardPicture(f)); };
  const png = await card();

  // ---------------- the page and the Worker agree ----------------
  check('the Worker\'s machines are every model, by the name people know', JSON.stringify(W.MACHINES) === JSON.stringify(Object.fromEntries(Object.entries(Emu.profiles).map(([k, p]) => [k, p.name]))));
  check('the Worker\'s limits are the page\'s (Session.SHORT_SEALED_MAX, SHORT_PNG)', W.MAX_SEALED === Emu.Session.SHORT_SEALED_MAX && W.MAX_PNG === Emu.Session.SHORT_PNG.bytes && W.PNG_COLOURS === Emu.Session.SHORT_PNG.colours);
  const body = Emu.newLinkBody('coco3', sealed(100), png);
  const read = W.readNewLink(body);
  check('newLinkBody is what the Worker reads', read.machine === 'coco3' && Buffer.from(read.sealed).equals(Buffer.from(sealed(100))) && Buffer.from(read.png).equals(Buffer.from(png)));
  check('newLinkBody: [1][n][machine][u32 LE length][sealed][png], bytes as worked out', Buffer.from(body.subarray(0, 12)).toString('hex') === '01' + '05' + Buffer.from('coco3').toString('hex') + '64000000' + Buffer.from([sealed(100)[0]]).toString('hex'),
    Buffer.from(body.subarray(0, 12)).toString('hex'));

  // ---------------- making a link ----------------
  {
    const env = envOf();
    const res = await call(env, req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(), png) }));
    const out = await res.json();
    check('made: 201 with an 8-character id and a delete token', res.status === 201 && /^[A-Za-z0-9_-]{8}$/.test(out.id) && /^[A-Za-z0-9_-]{22}$/.test(out.deleteToken), JSON.stringify(out));
    check('made: CORS for cloadm.dev only, never cached', res.headers.get('Access-Control-Allow-Origin') === ORIGIN && res.headers.get('Cache-Control') === 'no-store');
    const b = env.BUCKET.objects;
    check('made: <id>.bin holds exactly the sealed bytes, <id>.png the picture, <id> the page', Buffer.from(b.get(`${out.id}.bin`).bytes).equals(Buffer.from(sealed()))
      && Buffer.from(b.get(`${out.id}.png`).bytes).equals(Buffer.from(png)) && b.has(out.id));
    check('made: content types and a day\'s cache on each', b.get(`${out.id}.bin`).httpMetadata.contentType === 'application/octet-stream' && b.get(`${out.id}.png`).httpMetadata.contentType === 'image/png'
      && /^text\/html/.test(b.get(out.id).httpMetadata.contentType) && [`${out.id}.bin`, `${out.id}.png`, out.id].every((k) => b.get(k).httpMetadata.cacheControl === 'public, max-age=86400'));
    const meta = b.get(`${out.id}.bin`).customMetadata;
    check('made: the delete token is kept only as its SHA-256', meta.tokenHash === require('crypto').createHash('sha256').update(out.deleteToken).digest('hex') && !JSON.stringify([...b.values()].map((o) => o.customMetadata)).includes(out.deleteToken));
    check('made: no expiry anywhere (links don\'t expire)', ![...b.values()].some((o) => o.httpMetadata.cacheExpiry || /expire/i.test(JSON.stringify(o.customMetadata))));
    const html = env.BUCKET.text(out.id);
    const metaOf = (p) => (new RegExp(`<meta (?:property|name)="${p}" content="([^"]*)">`).exec(html) || [])[1];
    check('the arrival page: og:title, og:image (its picture), twitter large card, og:url', metaOf('og:title') === 'A moment on a Dragon 64, CLOADM' && metaOf('og:image') === `https://s.cloadm.dev/${out.id}.png`
      && metaOf('twitter:card') === 'summary_large_image' && metaOf('og:url') === `https://s.cloadm.dev/${out.id}` && metaOf('og:image:width') === '1200' && metaOf('og:image:height') === '630');
    const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [])[1], style = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1];
    const csp = (/http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html) || [])[1] || '';
    const h = (t) => require('crypto').createHash('sha256').update(t).digest('base64');
    check('the arrival page: its one script and style allowed by their hashes, and nothing else (default-src none)', csp.includes(`script-src 'sha256-${h(script)}'`) && csp.includes(`style-src 'sha256-${h(style)}'`)
      && /default-src 'none'/.test(csp) && (html.match(/<script/g) || []).length === 1, csp);
    check('the arrival page: the script counts the open and goes to cloadm.dev/play/#l=<id>.<key>, the same for every link', script === W.ARRIVAL_SCRIPT && script.includes("location.replace('https://cloadm.dev/play/#l='+id+'.'+k)") && !script.includes(out.id));
    check('the arrival page: "Report this link" mails the id only', html.includes(`<a href="mailto:abuse@example.com?subject=Report%20CLOADM%20link%20${out.id}">Report this link</a>`));
    // nothing from the request but the machine's id (mapped to our own name) is in the page
    const text = html.replace(/<[^>]*>/g, ' ');
    check('the arrival page: no bytes of the moment, no address, no token', !html.includes(out.deleteToken) && !html.includes(IP) && !html.includes('dragon64'), text.replace(/\s+/g, ' ').slice(0, 80));

    // run the arrival script as a browser would: it pings /api/opened and goes on with the key
    const calls = [], loc = { pathname: `/${out.id}`, hash: '#0123456789abcdefghijkl', replaced: null, replace(u) { this.replaced = u; } };
    new Function('fetch', 'location', 'document', script)((u, o) => { calls.push([u, o.method]); return Promise.resolve(); }, loc, { getElementById: () => ({}) });
    check('the arrival script: POST /api/opened (no id), then cloadm.dev/play/#l=<id>.<key>', JSON.stringify(calls) === JSON.stringify([['/api/opened', 'POST']]) && loc.replaced === `https://cloadm.dev/play/#l=${out.id}.0123456789abcdefghijkl`, loc.replaced);
    const said = {}, nokey = { pathname: `/${out.id}`, hash: '', replaced: null, replace(u) { this.replaced = u; } };
    new Function('fetch', 'location', 'document', script)(() => Promise.resolve(), nokey, { getElementById: () => said });
    check('the arrival script: a link without its key stays and says what is missing', nokey.replaced === null && /missing its key/.test(said.textContent));

    // without a picture
    const r2 = await (await call(env, req('/api/new', { body: Emu.newLinkBody('mc10', sealed(500, 2)) }))).json();
    const h2 = env.BUCKET.text(r2.id);
    check('no picture: no <id>.png, the site icon as og:image, a small card', !b.has(`${r2.id}.png`) && h2.includes('content="https://cloadm.dev/icons/icon-512.png"') && h2.includes('content="summary"') && /A moment on a MC-10, CLOADM/.test(h2));
    const noReport = envOf({ REPORT_EMAIL: '' });
    const r3 = await (await call(noReport, req('/api/new', { body: Emu.newLinkBody('coco', sealed()) }))).json();
    check('no report address configured: no Report link (never a broken one)', !/Report this link/.test(noReport.BUCKET.text(r3.id)));
    // an id already taken is never overwritten: another is drawn
    env.BUCKET.failNext.push((k) => k.endsWith('.bin'));
    const r4 = await call(env, req('/api/new', { body: Emu.newLinkBody('coco', sealed(64, 9)) }));
    const o4 = await r4.json();
    check('an id already taken: another is drawn, nothing overwritten', r4.status === 201 && Buffer.from(env.BUCKET.objects.get(`${o4.id}.bin`).bytes).equals(Buffer.from(sealed(64, 9))));

    // ---------------- delete ----------------
    const del = (id, token, origin = ORIGIN) => call(env, req('/api/delete', { body: JSON.stringify({ id, token }), type: 'application/json', origin }));
    check('delete with another token: 403, nothing removed', (await del(out.id, 'x'.repeat(22))).status === 403 && b.has(out.id));
    check('delete from another origin: 403', (await del(out.id, out.deleteToken, 'https://evil.example')).status === 403 && b.has(out.id));
    const d = await del(out.id, out.deleteToken);
    check('delete with its token: 204, all three objects gone', d.status === 204 && ![`${out.id}.bin`, `${out.id}.png`, out.id].some((k) => b.has(k)));
    check('delete again: 404 (it was removed)', (await del(out.id, out.deleteToken)).status === 404);
    check('a malformed delete: 400', (await call(env, req('/api/delete', { body: '{"id":"../x"}', type: 'application/json' }))).status === 400);
    await W.removeLink(env, r2.id);
    check('takedown by id (removeLink, the documented commands do the same): all three gone', !b.has(r2.id) && !b.has(`${r2.id}.bin`));

    // ---------------- counts ----------------
    for (let i = 0; i < 3; i++) await call(env, req('/api/opened', { origin: 'https://s.cloadm.dev' }));
    await call(env, req('/api/started', { body: 'wyrmfire', type: 'text/plain' }));
    const notCounted = await call(env, req('/api/started', { body: 'liza', type: 'text/plain' }));
    const c = JSON.parse(env.BUCKET.text('stats/counts.json'));
    check('counts: made, opened, removed, wyrmfire started; another program is not counted (400)', c.created === 3 && c.opened === 3 && c.removed === 1 && c.started.wyrmfire === 1 && !c.started.liza && notCounted.status === 400, JSON.stringify(c));
    const stats = env.BUCKET.text('stats/');
    check('the public totals page (stats/): the totals, nothing per person', /Short links made<\/td><td>3</.test(stats) && /Short links opened<\/td><td>3</.test(stats) && /wyrmfire started from its page<\/td><td>1</.test(stats));
    const everything = [...env.BUCKET.objects.values()].map((o) => new TextDecoder('latin1').decode(o.bytes) + JSON.stringify(o.customMetadata)).join('\n');
    check('no address is stored anywhere', !everything.includes(IP) && !everything.includes('203.0.113'));
    // a count written by someone else at the same moment is kept: the etag check fails once and the change is redone
    env.BUCKET.failNext.push((k) => k === 'stats/counts.json');
    await call(env, req('/api/opened'));
    check('counts: a concurrent write is retried, not lost', JSON.parse(env.BUCKET.text('stats/counts.json')).opened === 4);
  }

  // ---------------- refusals ----------------
  {
    const env = envOf();
    const status = async (r, e = env, now) => { const res = await call(e, r, now); return [res.status, (await res.json().catch(() => ({}))).error || '']; };
    const good = () => Emu.newLinkBody('dragon64', sealed());
    check('no Origin: 403', (await status(req('/api/new', { body: good(), origin: null })))[0] === 403);
    check('another origin: 403, no CORS header', (await status(req('/api/new', { body: good(), origin: 'https://evil.example' })))[0] === 403
      && !(await call(env, req('/api/new', { body: good(), origin: 'https://evil.example' }))).headers.get('Access-Control-Allow-Origin'));
    const pre = await call(env, new Request('https://s.cloadm.dev/api/new', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
    check('preflight from cloadm.dev: 204 allowing POST and Content-Type', pre.status === 204 && pre.headers.get('Access-Control-Allow-Methods') === 'POST' && /Content-Type/.test(pre.headers.get('Access-Control-Allow-Headers')));
    check('GET on the Worker: 405 (reads are R2\'s, never the Worker\'s)', (await status(req('/api/new', { method: 'GET', body: null })))[0] === 405);
    check('an unknown address: 404', (await status(req('/api/other', { body: 'x' })))[0] === 404);
    const [s1, m1] = await status(req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(64 * 1024 + 1)) }));
    check('a moment over 64 KB: 413', s1 === 413, m1);
    const big = new Uint8Array(33 * 1024);
    check('a picture over 32 KB: 413', (await status(req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(), big) })))[0] === 413);
    for (const [what, b] of [['version 2', Uint8Array.from([2, ...good().subarray(1)])], ['cut short', good().subarray(0, 40)], ['too short to be sealed', Emu.newLinkBody('dragon64', sealed(10))],
      ['a machine CLOADM lacks', Emu.newLinkBody('zx81', sealed())], ['empty', new Uint8Array(0)]]) {
      const [s, m] = await status(req('/api/new', { body: b }));
      check(`refused (400): ${what}`, s === 400, m);
    }
    // pictures: each check
    const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]); const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); };
    const ihdr = (w, h, depth, type) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = type; return chunk('IHDR', d); };
    const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), IEND = chunk('IEND', []);
    const idat = chunk('IDAT', zlib.deflateSync(Buffer.alloc(10)));
    const pngs = {
      'not a PNG': Buffer.from('GIF89a and more bytes here'),
      'another size (1200 x 600)': Buffer.concat([SIG, ihdr(1200, 600, 4, 3), chunk('PLTE', Buffer.alloc(6)), idat, IEND]),
      'true colour, not indexed': Buffer.concat([SIG, ihdr(1200, 630, 8, 2), idat, IEND]),
      '17 colours': Buffer.concat([SIG, ihdr(1200, 630, 8, 3), chunk('PLTE', Buffer.alloc(17 * 3)), idat, IEND]),
      'a text chunk (tEXt)': Buffer.concat([SIG, ihdr(1200, 630, 4, 3), chunk('PLTE', Buffer.alloc(6)), chunk('tEXt', Buffer.from('Comment\0hello')), idat, IEND]),
      'a damaged CRC': (() => { const p = Buffer.from(png); p[30] ^= 1; return p; })(),
      'interlaced': (() => { const d = Buffer.alloc(13); d.writeUInt32BE(1200, 0); d.writeUInt32BE(630, 4); d[8] = 4; d[9] = 3; d[12] = 1; return Buffer.concat([SIG, chunk('IHDR', d), chunk('PLTE', Buffer.alloc(6)), idat, IEND]); })(),
      'bytes after IEND': Buffer.concat([Buffer.from(png), Buffer.from([0])]),
    };
    for (const [what, p] of Object.entries(pngs)) {
      const [s, m] = await status(req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(), new Uint8Array(p)) }));
      check(`picture refused (400): ${what}`, s === 400, m);
    }
    check('nothing was stored by any refused request', ![...env.BUCKET.objects.keys()].some((k) => k.endsWith('.bin')));

    // the kill switch: no new links, the existing ones stay readable
    const k = envOf();
    const made = await (await call(k, req('/api/new', { body: good() }))).json();
    k.NEW_LINKS = 'off';
    const [ks, km] = await status(req('/api/new', { body: good() }), k);
    check('kill switch (NEW_LINKS=off): new links refused (503) with a message', ks === 503 && /switched off/.test(km), km);
    check('kill switch: the existing link\'s objects stay, and opens are still counted', k.BUCKET.objects.has(`${made.id}.bin`) && k.BUCKET.objects.has(made.id)
      && (await call(k, req('/api/opened'))).status === 204);
    check('kill switch: delete still works', (await call(k, req('/api/delete', { body: JSON.stringify({ id: made.id, token: made.deleteToken }), type: 'application/json' }))).status === 204);

    // limits
    const ipEnv = envOf({ RATE_IP: limiter(2) });
    const a = [];
    for (let i = 0; i < 3; i++) a.push((await status(req('/api/new', { body: good() }), ipEnv))[0]);
    const other = (await status(req('/api/new', { body: good(), ip: '198.51.100.9' }), ipEnv))[0];
    check('per address: the third in the window is refused (429), another address is not', JSON.stringify(a) === '[201,201,429]' && other === 201, JSON.stringify(a));
    check('per address: the limiter is keyed by the address and nothing else', ipEnv.RATE_IP.calls.every((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)));
    const allEnv = envOf({ RATE_ALL: limiter(1) });
    const g = [(await status(req('/api/new', { body: good() }), allEnv))[0], (await status(req('/api/new', { body: good(), ip: '198.51.100.9' }), allEnv))[0]];
    check('globally per minute (RATE_ALL): refused (429) whoever asks', JSON.stringify(g) === '[201,429]', JSON.stringify(g));
    const day = envOf({ DAILY_CAP: '2' });
    const dd = [];
    for (let i = 0; i < 3; i++) dd.push((await status(req('/api/new', { body: good(), ip: `198.51.100.${i}` }), day))[0]);
    const tomorrow = (await status(req('/api/new', { body: good() }), day, new Date('2026-11-25T00:00:01Z')))[0];
    check('the daily cap: the third of the day refused (429), the next day open again', JSON.stringify(dd) === '[201,201,429]' && tomorrow === 201, JSON.stringify(dd));
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
