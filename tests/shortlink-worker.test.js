// The short-link Worker (shortlink/worker.js), run in Node against an in-memory R2 bucket and stand-in rate limiters
// (the bindings a deployment configures: docs/shortlink-deploy.md). Nothing here reaches Cloudflare.
//  * making a link: the three objects, the sealed bytes as sent, the arrival page from its fixed template (its script
//    allowed by the hash in its CSP, worked out here; only the id and the machine's name in it; Report this link)
//  * every refusal: origin, kill switch (existing links stay), per-address, global and daily limits, sizes, malformed
//    requests, every way a picture can be wrong
//  * delete by token (wrong token refused, stored as a hash only); opens counted by the daily cron from the zone's
//    analytics (the request it makes, catching up missed days, never twice); counts kept under concurrent writes; the
//    public totals page; no address stored anywhere
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

    // run the arrival script as a browser would: it goes on with the key and sends nothing anywhere (no ping: opens
    // are counted from the zone's analytics, countOpens below), and its CSP allows no connection at all
    const calls = [], loc = { pathname: `/${out.id}`, hash: '#0123456789abcdefghijkl', replaced: null, replace(u) { this.replaced = u; } };
    const spy = (...a) => { calls.push(a); return Promise.resolve(); };
    new Function('fetch', 'navigator', 'XMLHttpRequest', 'location', 'document', script)(spy, { sendBeacon: spy }, function () { calls.push('xhr'); }, loc, { getElementById: () => ({}) });
    check('the arrival script: straight to cloadm.dev/play/#l=<id>.<key>, no request of any kind, connect-src none', calls.length === 0 && loc.replaced === `https://cloadm.dev/play/#l=${out.id}.0123456789abcdefghijkl`
      && /connect-src 'none'/.test(csp) && !/fetch|sendBeacon|XMLHttpRequest/.test(script), loc.replaced);
    const said = {}, nokey = { pathname: `/${out.id}`, hash: '', replaced: null, replace(u) { this.replaced = u; } };
    new Function('location', 'document', script)(nokey, { getElementById: () => said });
    check('the arrival script: a link without its key stays and says what is missing', nokey.replaced === null && /missing its key/.test(said.textContent));

    // without a picture
    const r2 = await (await call(env, req('/api/new', { body: Emu.newLinkBody('mc10', sealed(500, 2)) }))).json();
    const h2 = env.BUCKET.text(r2.id);
    check('no picture: no <id>.png, the site icon as og:image, a small card', !b.has(`${r2.id}.png`) && h2.includes('content="https://cloadm.dev/icons/icon-512.png"') && h2.includes('content="summary"') && /A moment on a MC-10, CLOADM/.test(h2));
    const noReport = envOf({ REPORT_EMAIL: '' });
    const r3 = await (await call(noReport, req('/api/new', { body: Emu.newLinkBody('coco', sealed()) }))).json();
    check('no report address configured: no Report link (never a broken one)', !/Report this link/.test(noReport.BUCKET.text(r3.id)));
    // the report page (GET /api/report/<id>, the play page's arrival card links to it): the arrival page's Report block
    // and nothing else; a 404 for an id of the wrong form; without REPORT_EMAIL it says so with no mailto; it reads no
    // object (a bucket whose every read throws still serves it) and needs no key (none is sent)
    {
      const reads = [], watched = envOf();
      watched.BUCKET.get = (k) => { reads.push(k); throw new Error('read'); };
      const rp = await call(watched, req(`/api/report/${out.id}`, { method: 'GET', origin: null }));
      const html = await rp.text();
      check('report page: 200 HTML with the arrival page\'s Report mailto for that id, its title, and no script or other copy',
        rp.status === 200 && /^text\/html/.test(rp.headers.get('content-type')) && html.includes(`<a href="mailto:abuse@example.com?subject=Report%20CLOADM%20link%20${out.id}">Report this link</a>`)
        && html.includes(`<title>Report CLOADM link ${out.id}</title>`) && !/<script/i.test(html) && html.replace(/<style>[^<]*<\/style>/, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() === `Report CLOADM link ${out.id} Report this link`, html);
      check('report page: never reads the bucket (no key, no link needed)', reads.length === 0, reads.join());
      const removed = await call(envOf(), req('/api/report/Zz9_-xYw', { method: 'GET', origin: null }));
      check('report page: an id that names no link (removed, say) is served all the same', removed.status === 200);
      for (const bad of ['short', 'toolongid1', 'ab%3Ccd%3Eef', 'abcd.efg', `${out.id}/x`]) {
        const r = await call(envOf(), req(`/api/report/${bad}`, { method: 'GET', origin: null }));
        check(`report page: ${bad} is not an id: 404`, r.status === 404);
      }
      const none = await (await call(envOf({ REPORT_EMAIL: '' }), req(`/api/report/${out.id}`, { method: 'GET', origin: null }))).text();
      check('report page without REPORT_EMAIL: "Reporting isn\'t set up for this server." and no mailto', none.includes("<p>Reporting isn't set up for this server.</p>") && !/mailto:/.test(none), none);
      const post = await call(envOf(), req(`/api/report/${out.id}`, { body: 'x' }));
      check('report page: only GET (a POST is 405)', post.status === 405);
    }
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
    check('no ping addresses: /api/opened and /api/started are not there (404)', (await call(env, req('/api/opened'))).status === 404
      && (await call(env, req('/api/started', { body: 'wyrmfire', type: 'text/plain' }))).status === 404);
    const c = JSON.parse(env.BUCKET.text('stats/counts.json'));
    check('counts: made and removed, nothing opened yet (opens come from the daily analytics run)', c.created === 3 && c.removed === 1 && c.opened === 0 && !('started' in c), JSON.stringify(c));
    // opens: the daily cron asks the zone's analytics for yesterday's successful GETs of /<id>.bin and adds the total once
    const asked = [];
    const analytics = (answer) => async (url, init) => { asked.push({ url, init }); return typeof answer === 'function' ? answer() : new Response(JSON.stringify(answer), { status: 200 }); };
    const counted = (n) => ({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: n }] }] } } });
    const day1 = new Date('2026-11-25T03:17:00Z');
    check('opens: not configured (no token or zone): nothing asked, nothing added', (await W.addOpens(env, day1, analytics(counted(9)))) === null && asked.length === 0);
    env.CF_ANALYTICS_TOKEN = 'test-analytics-token'; env.ZONE_ID = 'zone0123';
    const got = await W.addOpens(env, day1, analytics(counted(7)));
    const q = asked[0], qb = q && JSON.parse(q.init.body);
    check('opens: one POST to the GraphQL API with the token, for the zone and yesterday (UTC)', asked.length === 1 && q.url === 'https://api.cloudflare.com/client/v4/graphql'
      && q.init.headers.Authorization === 'Bearer test-analytics-token' && qb.variables.zone === 'zone0123'
      && qb.variables.start === '2026-11-24T00:00:00.000Z' && qb.variables.end === '2026-11-25T00:00:00.000Z', q && q.init.body.slice(0, 160));
    check('opens: the query counts successful GETs of s.cloadm.dev/<id>.bin and nothing about who', /clientRequestHTTPHost: "s\.cloadm\.dev"/.test(qb.query) && /clientRequestPath_like: "\/%\.bin"/.test(qb.query)
      && /clientRequestHTTPMethodName: "GET"/.test(qb.query) && /edgeResponseStatus: 200/.test(qb.query) && /\{ count \}/.test(qb.query) && !/clientIP|userAgent|country/i.test(qb.query));
    const c1 = JSON.parse(env.BUCKET.text('stats/counts.json'));
    check('opens: added, and the day recorded', got.opens === 7 && c1.opened === 7 && c1.openedThrough === '2026-11-24', JSON.stringify(c1));
    await W.addOpens(env, new Date('2026-11-25T20:00:00Z'), analytics(counted(7)));
    check('opens: a second run the same day asks nothing and adds nothing', asked.length === 1 && JSON.parse(env.BUCKET.text('stats/counts.json')).opened === 7);
    const failed = await W.addOpens(env, new Date('2026-11-26T03:17:00Z'), analytics(() => new Response('{"errors":[{"message":"rate limited"}]}', { status: 429 }))).then(() => null, (e) => e);
    check('opens: the analytics API failing adds nothing and keeps the day uncounted', failed instanceof Error && JSON.parse(env.BUCKET.text('stats/counts.json')).openedThrough === '2026-11-24');
    await W.addOpens(env, new Date('2026-11-27T03:17:00Z'), analytics(counted(5)));
    const qc = JSON.parse(asked[asked.length - 1].init.body).variables, c2 = JSON.parse(env.BUCKET.text('stats/counts.json'));
    check('opens: the next run catches up, both missed days in one query', qc.start === '2026-11-25T00:00:00.000Z' && qc.end === '2026-11-27T00:00:00.000Z' && c2.opened === 12 && c2.openedThrough === '2026-11-26', JSON.stringify(qc));
    // the Worker's own scheduled handler (the Cron Trigger) does the same, through the platform's fetch
    {
      const real = globalThis.fetch, waits = [];
      globalThis.fetch = analytics(counted(0));
      try { await worker.scheduled({ scheduledTime: Date.parse('2026-11-28T03:17:00Z') }, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); }
      finally { globalThis.fetch = real; }
      const cs = JSON.parse(env.BUCKET.text('stats/counts.json'));
      check('the scheduled handler (Cron Trigger) counts through to yesterday', waits.length === 1 && cs.openedThrough === '2026-11-27' && cs.opened === 12, JSON.stringify(cs));
      await W.addOpens(env, new Date('2026-11-27T03:17:00Z'), analytics(counted(99)));   // an earlier day again: nothing
      check('a run for days already counted changes nothing', JSON.parse(env.BUCKET.text('stats/counts.json')).opened === 12);
      // two runs at once (a retried Cron Trigger): both read the counts before either writes, both ask; the day is added once
      const before = JSON.parse(env.BUCKET.text('stats/counts.json')).opened;
      await Promise.all([W.addOpens(env, new Date('2026-11-29T03:17:00Z'), analytics(counted(3))), W.addOpens(env, new Date('2026-11-29T03:17:00Z'), analytics(counted(3)))]);
      const both = JSON.parse(env.BUCKET.text('stats/counts.json'));
      check('two runs at once for the same day add its opens once', both.opened === before + 3 && both.openedThrough === '2026-11-28', JSON.stringify(both));

    }
    const stats = env.BUCKET.text('stats/');
    check('the public totals page (stats/): the totals, nothing per person', /Short links made<\/td><td>3</.test(stats) && /Short links opened, approximately \(to the end of 2026-11-28\)<\/td><td>15</.test(stats)
      && /Short links deleted by whoever made them<\/td><td>1</.test(stats)
      && /Opens are approximate: they come from Cloudflare's sampled analytics, and a browser revalidating a copy it already has \(304\) is not counted\./.test(stats));
    const everything = [...env.BUCKET.objects.values()].map((o) => new TextDecoder('latin1').decode(o.bytes) + JSON.stringify(o.customMetadata)).join('\n');
    check('no address is stored anywhere, nor the analytics token', !everything.includes(IP) && !everything.includes('203.0.113') && !everything.includes('test-analytics-token'));
    // a count written by someone else between the Worker's read and its write (a link made, landing first) is kept:
    // the etag check refuses the stale write and the change is redone on the new counts
    let raced = false;
    env.BUCKET.beforePut = async (k) => {
      if (k !== 'stats/counts.json' || raced) return;
      raced = true;
      const o = env.BUCKET.objects.get(k), c3 = JSON.parse(new TextDecoder().decode(o.bytes));
      c3.created++;
      env.BUCKET.objects.set(k, Object.assign({}, o, { bytes: new TextEncoder().encode(JSON.stringify(c3)), etag: `race${++env.BUCKET.n}` }));
    };
    await W.addOpens(env, new Date('2026-11-30T03:17:00Z'), analytics(counted(4)));
    env.BUCKET.beforePut = null;
    const c4 = JSON.parse(env.BUCKET.text('stats/counts.json'));
    check('counts: a concurrent write is kept, and this one redone on top of it', raced && c4.created === 4 && c4.opened === 19, env.BUCKET.text('stats/counts.json'));
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
      // its pixels: each built here from rows of (stride + 1) bytes, 4 bits a pixel, 600 bytes a row
      ...(() => {
        const rows = (fill = 0, filter = 0, h = 630) => { const r = Buffer.alloc(601 * h, fill); for (let y = 0; y < h; y++) r[y * 601] = filter; return r; };
        const plte = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]));   // two colours: indices 0 and 1
        const make = (raw, { depth = 4, comp = 0, filt = 0 } = {}) => { const d = Buffer.alloc(13); d.writeUInt32BE(1200, 0); d.writeUInt32BE(630, 4); d[8] = depth; d[9] = 3; d[10] = comp; d[11] = filt;
          return Buffer.concat([SIG, chunk('IHDR', d), plte, chunk('IDAT', zlib.deflateSync(raw)), IEND]); };
        const ihdrOnly = (() => { const d = Buffer.alloc(13); d.writeUInt32BE(1200, 0); d.writeUInt32BE(630, 4); d[8] = 4; d[9] = 3; return chunk('IHDR', d); })();
        return {
          'no IDAT': Buffer.concat([SIG, ihdrOnly, plte, IEND]),
          'IHDR compression method 1': make(rows(), { comp: 1 }),
          'IHDR filter method 1': make(rows(), { filt: 1 }),
          'PLTE after IDAT': Buffer.concat([SIG, ihdrOnly, chunk('IDAT', zlib.deflateSync(rows())), plte, IEND]),
          'IDATs apart (another chunk between them)': Buffer.concat([SIG, ihdrOnly, plte, chunk('IDAT', zlib.deflateSync(rows()).subarray(0, 20)), plte, chunk('IDAT', zlib.deflateSync(rows()).subarray(20)), IEND]),
          'garbage IDAT (not zlib)': Buffer.concat([SIG, ihdrOnly, plte, chunk('IDAT', Buffer.from('this is not a zlib stream at all')), IEND]),
          'an inflation bomb (32 MB of zeroes in a few KB)': (() => { const b = make(Buffer.alloc(32 << 20)); return b; })(),
          'image data short of its size (one row missing)': make(rows(0, 0, 629)),
          'a row filter of 5': make((() => { const r = rows(); r[601 * 7] = 5; return r; })()),
          'a pixel past the palette (colour 3 of 2)': make((() => { const r = rows(); r[601 * 300 + 1 + 10] = 0x03; return r; })()),
          'a pixel past the palette only after unfiltering (Sub: 1 + 1 = 2)': make((() => { const r = rows(); r[601 * 9] = 1; r[601 * 9 + 1] = 0x11; r[601 * 9 + 2] = 0x11; return r; })()),
        };
      })(),
    };
    // (the reason, where a case could be refused for another one: a bomb must be stopped by the bound, not after)
    const because = { 'no IDAT': /no image data/, 'an inflation bomb (32 MB of zeroes in a few KB)': /unpacks to more than its size allows/,
      'garbage IDAT (not zlib)': /image data is damaged/, 'image data short of its size (one row missing)': /not the size its header says/ };
    for (const [what, p] of Object.entries(pngs)) {
      if (p.length > W.MAX_PNG) { check(`(test) the case fits the size cap: ${what}`, false, `${p.length} bytes`); continue; }
      const [s, m] = await status(req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(), new Uint8Array(p)) }));
      check(`picture refused (400): ${what}`, s === 400 && (!because[what] || because[what].test(m)), m);
    }
    // and one built the same way but right is taken (the cases above fail for their reason, not the builder's)
    {
      const d = Buffer.alloc(13); d.writeUInt32BE(1200, 0); d.writeUInt32BE(630, 4); d[8] = 4; d[9] = 3;
      const raw = Buffer.alloc(601 * 630); for (let y = 0; y < 630; y++) { raw[y * 601] = y % 5; raw[y * 601 + 1] = y % 5 === 0 ? 0x10 : 0; }
      const ok = Buffer.concat([SIG, chunk('IHDR', d), chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), chunk('IDAT', zlib.deflateSync(raw)), IEND]);
      const res = await call(env, req('/api/new', { body: Emu.newLinkBody('dragon64', sealed(), new Uint8Array(ok)) }));
      const made = await res.json();
      check('a picture built here, every filter 0 to 4, colours 0 and 1: taken', res.status === 201 && env.BUCKET.objects.has(`${made.id}.png`), JSON.stringify(made));
      await W.removeLink(env, made.id);
    }
    check('nothing was stored by any refused request', ![...env.BUCKET.objects.keys()].some((k) => k.endsWith('.bin') || k.endsWith('.png')));

    // the totals can't block making a link: a stream of other writes to stats/counts.json (it changes under every
    // attempt) leaves /api/new answering 201, the link stored; the daily cap is counted in its own object
    {
      const busy = envOf();
      busy.BUCKET.beforePut = async (k) => {
        if (k !== 'stats/counts.json') return;
        const o = busy.BUCKET.objects.get(k);
        if (o) busy.BUCKET.objects.set(k, Object.assign({}, o, { etag: `other${++busy.BUCKET.n}` }));
        else busy.BUCKET.objects.set(k, { bytes: new TextEncoder().encode('{"created":0,"opened":0,"removed":0}'), etag: `other${++busy.BUCKET.n}`, customMetadata: {}, httpMetadata: {} });
      };
      const r1 = await call(busy, req('/api/new', { body: good() }));
      const o1 = await r1.json();
      check('a stream of writes to the totals can\'t block /api/new: 201, the link stored, the day counted apart', r1.status === 201 && busy.BUCKET.objects.has(`${o1.id}.bin`)
        && JSON.parse(busy.BUCKET.text('limits/today.json')).n === 1, JSON.stringify(o1));
    }
    {
      const fails = envOf();
      for (let i = 0; i < 5; i++) fails.BUCKET.failNext.push((k) => k.endsWith('.bin'));
      const [s5] = await status(req('/api/new', { body: good() }), fails);
      const c5 = fails.BUCKET.text('stats/counts.json');
      check('a link that could not be stored is not counted as made', s5 === 503 && (!c5 || JSON.parse(c5).created === 0), c5);
      const delEnv = envOf({ RATE_IP: limiter(1) });
      const d1 = (await status(req('/api/delete', { body: JSON.stringify({ id: 'AAAAAAAA', token: 'x' }), type: 'application/json' }), delEnv))[0];
      const d2 = (await status(req('/api/delete', { body: JSON.stringify({ id: 'AAAAAAAA', token: 'x' }), type: 'application/json' }), delEnv))[0];
      check('delete is rate-limited per address too', d1 === 404 && d2 === 429, `${d1} ${d2}`);
    }

    // the kill switch: no new links, the existing ones stay readable
    const k = envOf();
    const made = await (await call(k, req('/api/new', { body: good() }))).json();
    k.NEW_LINKS = 'off';
    const [ks, km] = await status(req('/api/new', { body: good() }), k);
    check('kill switch (NEW_LINKS=off): new links refused (503) with a message', ks === 503 && /switched off/.test(km), km);
    check('kill switch: the existing link\'s objects stay (reads never run the Worker)', k.BUCKET.objects.has(`${made.id}.bin`) && k.BUCKET.objects.has(made.id));
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
