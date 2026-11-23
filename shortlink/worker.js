/*
 * The short-link Worker (https://s.cloadm.dev/api/...): it stores short links and counts, and does nothing else. The
 * owner deploys it (docs/shortlink-deploy.md); nothing in the repository deploys it.
 *
 * A short link is https://s.cloadm.dev/<id>#<key>. The page (js/host/link-store.js) seals the moment with AES-GCM in
 * the browser (js/media/link-crypto.js) and sends only the sealed bytes: the key stays in the link's fragment, which
 * browsers never send, so this server cannot read a moment. Per link, three R2 objects:
 *   <id>.bin  the sealed moment (64 KB at most)
 *   <id>.png  the preview picture, only when the person chose to show one: a 1200 x 630 indexed PNG, 16 colours or
 *             fewer, 32 KB at most, checked chunk by chunk (js/media/png.js readPngHeader)
 *   <id>      the arrival page: a FIXED template (arrivalPage below) whose only variables are the id (8 base64url
 *             characters, made here) and the machine's name (from MACHINES, never from the request); its one script,
 *             allowed by its hash, counts the open and goes on to https://cloadm.dev/play/#l=<id>.<key>.
 * Reads are R2 through the cache on the s.cloadm.dev custom domain: this Worker runs only on /api/*. Links never expire.
 *
 * POST /api/new      body: [u8 1][u8 n][n bytes machine id][u32 LE sealed length][sealed][png, or nothing]
 *                    -> 201 { id, deleteToken }. Refused: NEW_LINKS="off" (the kill switch, 503), the per-address
 *                    limit (RATE_IP, 429), the global limits (RATE_ALL per minute and DAILY_CAP a day, 429), anything
 *                    malformed (400) or too large (413), an origin other than ALLOWED_ORIGINS (403).
 * POST /api/delete   body JSON { id, token } -> 204; 403 when the token's SHA-256 is not the one stored with the link.
 * POST /api/opened   (the arrival page; no body)   -> 204, counts one open. No id, no address is kept.
 * POST /api/started  body: a program id in COUNTED_STARTS (a program page) -> 204, counts one start.
 * Counts live in one R2 object, stats/counts.json (written with an etag check so none is lost), and the public page
 * stats/ (static HTML, rewritten with each count) shows the totals. No address or per-person data is stored anywhere.
 */
import { readPngHeader } from '../js/media/png.js';

export const MAX_SEALED = 64 * 1024;
export const MAX_PNG = 32 * 1024;
export const PNG_WIDTH = 1200, PNG_HEIGHT = 630, PNG_COLOURS = 16;
export const PLAY = 'https://cloadm.dev/play/';
export const SHORT = 'https://s.cloadm.dev/';
// the machines a link may name, as people know them (js/machines/profiles.js; tests/shortlink-worker.test.js checks
// that this is every model and its name)
export const MACHINES = Object.freeze({
  dragon32: 'Dragon 32', dragon64: 'Dragon 64', dragon200: 'Dragon 200', dragon200e: 'Dragon 200-E', tanodr64: 'Tano Dragon 64',
  dgnalpha: 'Dragon Professional (Alpha)', d64plus: 'Dragon 64 Plus', coco: 'CoCo 1/2', coco2b: 'CoCo 2B', mx1600: 'Dynacom MX-1600',
  lzcolor64: 'LZ Color64', cd6809: 'Codimex CD-6809', cp400: 'Prológica CP-400', coco3: 'CoCo 3', coco3p: 'CoCo 3 (PAL)', mc10: 'MC-10',
  alice: 'Matra Alice',
});
// the programs whose starts are counted (their program pages send POST /api/started)
export const COUNTED_STARTS = Object.freeze(['wyrmfire']);
const ID = /^[A-Za-z0-9_-]{8}$/;

// ---------------- the arrival page ----------------
// Its script is the same for every link (it reads the id from the address), so its hash is fixed
export const ARRIVAL_SCRIPT = "fetch('/api/opened',{method:'POST',keepalive:true}).catch(function(){});"
  + "var id=location.pathname.slice(1),k=location.hash.slice(1);"
  + `if(/^[A-Za-z0-9_-]{8}$/.test(id)&&/^[A-Za-z0-9_-]{22}$/.test(k))location.replace('${PLAY}#l='+id+'.'+k);`
  + "else document.getElementById('m').textContent='This link is missing its key: copy the whole link, with the part after #.';";
export const ARRIVAL_STYLE = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0D0C;color:#E8EDE9;font:16px/1.5 system-ui,sans-serif}'
  + 'main{max-width:30em;padding:24px}a{color:#7CE08A}';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? new TextEncoder().encode(text) : text));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// (id, machine id, has a picture, report address) -> the arrival page's HTML. No text from the request reaches it.
export async function arrivalPage(id, machine, picture, reportTo) {
  if (!ID.test(id) || !MACHINES[machine]) throw new Error('arrivalPage: not an id or a machine');
  const title = `A moment on a ${MACHINES[machine]}, CLOADM`;
  const image = picture ? `${SHORT}${id}.png` : 'https://cloadm.dev/icons/icon-512.png';
  const report = /^[^@\s"<>]+@[A-Za-z0-9.-]+$/.test(reportTo || '')
    ? `<p><a href="mailto:${esc(reportTo)}?subject=${encodeURIComponent(`Report CLOADM link ${id}`)}">Report this link</a></p>` : '';
  const csp = `default-src 'none'; script-src 'sha256-${b64(await sha256(ARRIVAL_SCRIPT))}'; style-src 'sha256-${b64(await sha256(ARRIVAL_STYLE))}'; `
    + "connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="CLOADM">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="Open this moment in CLOADM, the Dragon and Color Computer emulator in your browser.">
<meta property="og:url" content="${SHORT}${id}">
<meta property="og:image" content="${image}">
${picture ? `<meta property="og:image:width" content="${PNG_WIDTH}">\n<meta property="og:image:height" content="${PNG_HEIGHT}">\n` : ''}<meta name="twitter:card" content="${picture ? 'summary_large_image' : 'summary'}">
<style>${ARRIVAL_STYLE}</style>
</head>
<body>
<main>
<p id="m">Opening a moment on a ${esc(MACHINES[machine])} in CLOADM…</p>
${report}</main>
<script>${ARRIVAL_SCRIPT}</script>
</body>
</html>
`;
}

// ---------------- checks ----------------
export class Refused extends Error { constructor(status, message) { super(message); this.status = status; } }

// the picture as the Worker takes it, or a Refused saying why not
export function checkPicture(png) {
  if (png.length > MAX_PNG) throw new Refused(413, `The picture is larger than ${MAX_PNG / 1024} KB.`);
  let h;
  try { h = readPngHeader(png); } catch (e) { throw new Refused(400, `The picture is not a well-formed PNG: ${e.message}.`); }
  if (h.width !== PNG_WIDTH || h.height !== PNG_HEIGHT) throw new Refused(400, `The picture must be ${PNG_WIDTH} x ${PNG_HEIGHT}.`);
  if (h.colourType !== 3 || ![1, 2, 4, 8].includes(h.depth) || h.interlace !== 0) throw new Refused(400, 'The picture must be an indexed-colour PNG, not interlaced.');
  if (!h.palette || h.palette.length > PNG_COLOURS) throw new Refused(400, `The picture must have a palette of ${PNG_COLOURS} colours or fewer.`);
  if (h.chunks.some((t) => !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(t))) throw new Refused(400, 'The picture may hold only IHDR, PLTE, IDAT and IEND chunks.');
  return h;
}

// the /api/new body -> { machine, sealed, png | null }
export function readNewLink(body) {
  const fail = (m) => { throw new Refused(400, m); };
  if (body.length < 7 || body[0] !== 1) fail('Not a short-link request this server reads.');
  const n = body[1];
  if (2 + n + 4 > body.length) fail('The request is cut short.');
  const machine = String.fromCharCode(...body.subarray(2, 2 + n));
  if (!Object.hasOwn(MACHINES, machine)) fail('That is not a machine CLOADM has.');
  const len = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(2 + n, true);
  const start = 2 + n + 4;
  if (len > MAX_SEALED) throw new Refused(413, `A moment is larger than ${MAX_SEALED / 1024} KB.`);
  if (len < 28 || start + len > body.length) fail('The request is cut short.');
  const sealed = body.slice(start, start + len), rest = body.subarray(start + len);
  return { machine, sealed, png: rest.length ? rest.slice() : null };
}

// ---------------- counts ----------------
const COUNTS = 'stats/counts.json', STATS = 'stats/';
const today = (now) => now.toISOString().slice(0, 10);
// change the counts with `fn` (which may throw a Refused to stop), keeping every concurrent change (etag check, retried)
export async function bump(env, now, fn) {
  for (let tries = 0; tries < 8; tries++) {
    const cur = await env.BUCKET.get(COUNTS);
    const c = cur ? JSON.parse(await cur.text()) : { created: 0, opened: 0, removed: 0, started: {}, day: '', createdToday: 0 };
    if (c.day !== today(now)) { c.day = today(now); c.createdToday = 0; }
    fn(c);
    const put = await env.BUCKET.put(COUNTS, JSON.stringify(c), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
      onlyIf: cur ? { etagMatches: cur.etag } : new Headers({ 'If-None-Match': '*' }),
    });
    if (put) { await env.BUCKET.put(STATS, statsPage(c), { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=300' } }); return c; }
  }
  throw new Refused(503, 'The counts are busy: try again in a moment.');
}
export function statsPage(c) {
  const rows = [['Short links made', c.created], ['Short links opened', c.opened], ['Short links removed', c.removed],
    ...Object.entries(c.started || {}).map(([p, n]) => [`${p} started from its page`, n])];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CLOADM short links: totals</title>
<style>body{margin:0;padding:24px;background:#0B0D0C;color:#E8EDE9;font:16px/1.5 system-ui,sans-serif}td{padding:4px 16px 4px 0}td+td{text-align:right}</style></head>
<body><main><h1>CLOADM short links: totals</h1>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${Number(v) | 0}</td></tr>`).join('')}</table>
<p>Totals only: no addresses and nothing about who made or opened a link is kept.</p></main></body></html>
`;
}

// ---------------- the Worker ----------------
const allowed = (env) => (env.ALLOWED_ORIGINS || 'https://cloadm.dev').split(',').map((s) => s.trim()).filter(Boolean);
function cors(env, origin) {
  const h = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (origin && allowed(env).includes(origin)) { h.set('Access-Control-Allow-Origin', origin); h.set('Vary', 'Origin'); }
  return h;
}
const json = (status, body, headers) => { headers.set('Content-Type', 'application/json'); return new Response(JSON.stringify(body), { status, headers }); };
const randomId = () => { const b = crypto.getRandomValues(new Uint8Array(6)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_'); };
const randomToken = () => { const b = crypto.getRandomValues(new Uint8Array(16)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function readBody(request, max) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new Refused(413, 'The request is too large.');
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > max) throw new Refused(413, 'The request is too large.');
  return body;
}

async function newLink(request, env, now) {
  if (String(env.NEW_LINKS || 'on').toLowerCase() === 'off') throw new Refused(503, 'New short links are switched off for now. The long link still works.');
  const addr = request.headers.get('CF-Connecting-IP') || 'unknown';   // used for the limit only, never stored
  if (env.RATE_IP && !(await env.RATE_IP.limit({ key: addr })).success) throw new Refused(429, 'Too many short links from here: wait a minute.');
  if (env.RATE_ALL && !(await env.RATE_ALL.limit({ key: 'all' })).success) throw new Refused(429, 'Too many short links are being made right now: try again soon.');
  const { machine, sealed, png } = readNewLink(await readBody(request, 2 + 255 + 4 + MAX_SEALED + MAX_PNG));
  if (png) checkPicture(png);
  const cap = Number(env.DAILY_CAP || 5000);
  await bump(env, now, (c) => { if (c.createdToday >= cap) throw new Refused(429, 'Today\'s short links have all been made: try again tomorrow. The long link still works.'); c.created++; c.createdToday++; });
  const token = randomToken(), tokenHash = hex(await sha256(token));
  for (let tries = 0; tries < 5; tries++) {
    const id = randomId();
    const put = await env.BUCKET.put(`${id}.bin`, sealed, {
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'public, max-age=86400' },
      customMetadata: { tokenHash, machine, created: now.toISOString().slice(0, 10) },
      onlyIf: new Headers({ 'If-None-Match': '*' }),
    });
    if (!put) continue;   // that id is taken: another one
    if (png) await env.BUCKET.put(`${id}.png`, png, { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=86400' } });
    await env.BUCKET.put(id, await arrivalPage(id, machine, !!png, env.REPORT_EMAIL), { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=86400' } });
    return { id, deleteToken: token };
  }
  throw new Refused(503, 'Could not find a free link name: try again.');
}

export async function removeLink(env, id) { await env.BUCKET.delete([`${id}.bin`, `${id}.png`, id]); }

async function deleteLink(request, env, now) {
  let body;
  try { body = JSON.parse(new TextDecoder().decode(await readBody(request, 1024))); } catch (e) { throw new Refused(400, 'Not a delete request.'); }
  if (!body || !ID.test(body.id) || typeof body.token !== 'string' || body.token.length > 64) throw new Refused(400, 'Not a delete request.');
  const head = await env.BUCKET.head(`${body.id}.bin`);
  if (!head) throw new Refused(404, 'That link is not there (it was removed already).');
  const want = (head.customMetadata || {}).tokenHash || '', got = hex(await sha256(body.token));
  let diff = want.length ^ got.length;
  for (let i = 0; i < Math.min(want.length, got.length); i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) throw new Refused(403, 'That is not this link\'s delete token.');
  await removeLink(env, body.id);
  await bump(env, now, (c) => { c.removed++; });
}

export default {
  async fetch(request, env, ctx, now = new Date()) {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    const headers = cors(env, origin);
    try {
      if (request.method === 'OPTIONS') {
        if (!origin || !allowed(env).includes(origin)) throw new Refused(403, 'Not from CLOADM.');
        headers.set('Access-Control-Allow-Methods', 'POST'); headers.set('Access-Control-Allow-Headers', 'Content-Type'); headers.set('Access-Control-Max-Age', '86400');
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'POST') { headers.set('Allow', 'POST'); throw new Refused(405, 'Only POST here.'); }
      switch (url.pathname) {
        case '/api/new':
          if (!origin || !allowed(env).includes(origin)) throw new Refused(403, 'Short links are made by CLOADM\'s own page.');
          return json(201, await newLink(request, env, now), headers);
        case '/api/delete':
          if (!origin || !allowed(env).includes(origin)) throw new Refused(403, 'Short links are removed from CLOADM\'s own page.');
          await deleteLink(request, env, now);
          return new Response(null, { status: 204, headers });
        case '/api/opened':
          await bump(env, now, (c) => { c.opened++; });
          return new Response(null, { status: 204, headers });
        case '/api/started': {
          const p = new TextDecoder().decode(await readBody(request, 64)).trim();
          if (!COUNTED_STARTS.includes(p)) throw new Refused(400, 'Not a program whose starts are counted.');
          await bump(env, now, (c) => { c.started[p] = (c.started[p] || 0) + 1; });
          return new Response(null, { status: 204, headers });
        }
        default: throw new Refused(404, 'No such address.');
      }
    } catch (e) {
      if (e instanceof Refused) return json(e.status, { error: e.message }, headers);
      return json(500, { error: 'Something went wrong on the server.' }, headers);
    }
  },
};
