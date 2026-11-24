// Short links on the page's side: the sealing (js/media/link-crypto.js), the store (js/host/link-store.js) over a mocked
// fetch, and the Session (shortLink, readShortLink, shortLinkRefusal, previewPicture).
//  * sealing: round trip; a fresh key and IV each time; a changed byte, a cut, or another key refused
//  * the store's requests: their shape (address, method, type, body = newLinkBody), the server's errors and an
//    unreachable server as messages, an answer it doesn't understand
//  * THE KEY NEVER LEAVES THE PAGE: every request made while making and opening a link is searched for the key (as
//    text, as bytes, in base64 and hex) and for the moment's own bytes; none has either
//  * a moment opened from a short link runs on exactly as the original (instructions, cycles, frames, memory)
//  * guardrails: a moment on ROMs, with a cartridge, or under NitrOS-9 gets no short link, with its reason, and no
//    request is made; one too large is refused before any upload; a picture with too many colours goes without one
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
function run(m, frames) {
  let h = 0x811C9DC5;
  m.cpu.trace = (c) => { h = fnv(h, c.pc); h = fnv(h, c.a | 0); h = fnv(h, c.b | 0); h = fnv(h, c.totalCycles); };
  for (let f = 0; f < frames; f++) { m.runFrame(); const px = m.render().data; for (let i = 0; i < px.length; i += 3) h = fnv(h, px[i]); }
  m.cpu.trace = null;
  for (const v of m.memoryArray()) h = fnv(h, v);
  return h >>> 0;
}
// a stand-in short-link server behind a mocked fetch: every request recorded, as the browser would send it
function server({ fail: failWith = null } = {}) {
  const store = new Map(), requests = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    const body = init.body == null ? new Uint8Array(0) : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body);
    requests.push({ url, method: init.method, headers: JSON.stringify(init.headers || {}), body });
    if (failWith === 'network') throw new TypeError('Failed to fetch');
    if (failWith) return new Response(JSON.stringify({ error: failWith.message }), { status: failWith.status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(url);
    if (u.pathname === '/api/new') { const id = `id${String(++n).padStart(6, '0')}`; store.set(id, body); return new Response(JSON.stringify({ id, deleteToken: `tok${n}`.padEnd(22, 'x') }), { status: 201 }); }
    if (u.pathname === '/api/delete') { const { id } = JSON.parse(new TextDecoder().decode(body)); store.delete(id); return new Response(null, { status: 204 }); }
    const m = /^\/([A-Za-z0-9_-]{8})\.bin$/.exec(u.pathname);
    if (m && store.has(m[1])) { const b = store.get(m[1]), sealedLen = new DataView(b.buffer).getUint32(2 + b[1], true); return new Response(b.slice(6 + b[1], 6 + b[1] + sealedLen), { status: 200 }); }
    return new Response('not found', { status: 404 });
  };
  return { fetch, store, requests };
}

(async () => {
  // ---------------- sealing ----------------
  {
    const msg = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xFF);
    const a = await Emu.sealMoment(msg), b = await Emu.sealMoment(msg);
    check('sealing: a 22-character base64url key, IV + ciphertext + tag', Emu.isLinkKey(a.key) && a.sealed.length === msg.length + Emu.SEAL_OVERHEAD);
    check('sealing: a fresh key and IV each time', a.key !== b.key && !Buffer.from(a.sealed.subarray(0, 12)).equals(Buffer.from(b.sealed.subarray(0, 12))));
    check('sealing: round trip', Buffer.from(await Emu.openMoment(a.sealed, a.key)).equals(Buffer.from(msg)));
    check('sealing: the moment\'s bytes are not in the sealed bytes', !Buffer.from(a.sealed).includes(Buffer.from(msg.subarray(100, 132))));
    const changed = a.sealed.slice(); changed[40] ^= 1;
    for (const [what, sealed, key] of [['a changed byte', changed, a.key], ['cut short', a.sealed.subarray(0, a.sealed.length - 1), a.key], ['another key', a.sealed, b.key], ['too short to be sealed', a.sealed.subarray(0, 20), a.key]]) {
      const e = await rejects(Emu.openMoment(sealed, key));
      check(`sealing: refused, ${what}`, e instanceof Emu.LinkCryptoError, e && e.message);
    }
    const e = await rejects(Emu.openMoment(a.sealed, 'short'));
    check('sealing: a key that is not one: refused', e instanceof Emu.LinkCryptoError && /key is missing or damaged/.test(e.message));
  }

  // ---------------- the store's requests ----------------
  {
    const sv = server(), st = new Emu.ShortLinkStore({ fetch: sv.fetch });
    const sealed = Uint8Array.from({ length: 300 }, (_, i) => i & 0xFF), png = Uint8Array.from([137, 80, 78, 71]);
    const r = await st.create({ machine: 'coco3', sealed, png });
    const q = sv.requests[0];
    check('create: POST https://s.cloadm.dev/api/new, octet-stream, the body newLinkBody makes', q.url === 'https://s.cloadm.dev/api/new' && q.method === 'POST'
      && /application\/octet-stream/.test(q.headers) && Buffer.from(q.body).equals(Buffer.from(Emu.newLinkBody('coco3', sealed, png))) && r.id === 'id000001');
    check('url(): https://s.cloadm.dev/<id>#<key>, built here', st.url('AbCdEfGh', 'k'.repeat(22)) === `https://s.cloadm.dev/AbCdEfGh#${'k'.repeat(22)}`);
    const got = await st.load(r.id);
    check('load: GET https://s.cloadm.dev/<id>.bin, the sealed bytes', sv.requests[1].url === `https://s.cloadm.dev/${r.id}.bin` && sv.requests[1].method === 'GET' && Buffer.from(got).equals(Buffer.from(sealed)));
    await st.remove(r.id, r.deleteToken);
    check('remove: POST api/delete with { id, token } as JSON', sv.requests[2].url === 'https://s.cloadm.dev/api/delete' && new TextDecoder().decode(sv.requests[2].body) === JSON.stringify({ id: r.id, token: r.deleteToken }));
    const gone = await rejects(st.load(r.id));
    check('load of a removed link: "removed, or never existed" (404)', gone instanceof Emu.ShortLinkError && gone.status === 404 && /removed, or never existed/.test(gone.message), gone && gone.message);
    const bad = await rejects(st.load('../etc/x'));
    check('load of an id that is not one: refused before any request', bad instanceof Emu.ShortLinkError && sv.requests.length === 4);
    const limited = new Emu.ShortLinkStore({ fetch: server({ fail: { status: 429, message: 'Too many short links from here: wait a minute.' } }).fetch });
    const e1 = await rejects(limited.create({ machine: 'coco', sealed }));
    check('the server\'s refusal reaches the page as its own message', e1 instanceof Emu.ShortLinkError && e1.status === 429 && e1.message === 'Too many short links from here: wait a minute.');
    const off = await rejects(new Emu.ShortLinkStore({ fetch: server({ fail: 'network' }).fetch }).create({ machine: 'coco', sealed }));
    check('an unreachable server: says so, and that the long link still works', off instanceof Emu.ShortLinkError && /Couldn't reach s\.cloadm\.dev.*long link still works/.test(off.message), off && off.message);
    const odd = new Emu.ShortLinkStore({ fetch: async () => new Response('{"id":"x"}', { status: 201 }) });
    check('an answer it does not understand: refused', (await rejects(odd.create({ machine: 'coco', sealed }))) instanceof Emu.ShortLinkError);
  }

  // ---------------- a moment made into a short link and opened elsewhere ----------------
  {
    const sv = server(), st = new Emu.ShortLinkStore({ fetch: sv.fetch });
    const s = new Emu.Session();
    s.switchMachine('dragon64');
    for (let i = 0; i < 25; i++) s.shownMachine.runFrame();
    s.shownMachine.poke(0x3000, 0x5A);
    check('a moment on the built-in firmware may have a short link', s.shortLinkRefusal() === null && s.longLinkRefusal() === null);
    const file = await s.shareFile(new Date('2026-11-24T10:00:00Z'));
    const r = await s.shortLink(st, { file });
    const key = new URL(r.url).hash.slice(1);
    check('the short link: https://s.cloadm.dev/<id>#<22-character key>, with its preview picture', /^https:\/\/s\.cloadm\.dev\/id000001#[A-Za-z0-9_-]{22}$/.test(r.url) && r.picture && r.pictureNote === null, r.url);
    const want = run(s.shownMachine, 12);
    const b = new Emu.Session();
    b.switchMachine('coco');
    const got = await b.readShortLink(`#l=${r.id}.${key}`, st);
    b.openSnapshot(got.snap);
    check('opened in another Session from #l=<id>.<key>: the same machine, running on identically', got.id === r.id && b.shownMachine.id === 'dragon64' && b.shownMachine.peek(0x3000) === 0x5A && run(b.shownMachine, 12) === want);
    // the key, and the moment itself, in no request
    const keyBytes = Buffer.from(key, 'base64url');
    const forms = [key, keyBytes.toString('hex'), keyBytes.toString('base64'), keyBytes.toString('base64url')];
    const leaks = sv.requests.filter((q) => forms.some((f) => q.url.includes(f) || q.headers.includes(f) || Buffer.from(q.body).toString('latin1').includes(f)) || Buffer.from(q.body).includes(keyBytes));
    check('the key is in no request: not in an address, a header or a body, as text, hex, base64 or bytes', sv.requests.length === 2 && leaks.length === 0, `${sv.requests.length} requests`);
    const plain = Buffer.from(file.bytes);
    check('the moment itself is in no request (only sealed bytes go)', !sv.requests.some((q) => Buffer.from(q.body).includes(plain.subarray(20, 60))));
    // what the page says when it can't open one
    const e1 = await rejects(b.readShortLink(`#l=${r.id}.${'A'.repeat(22)}`, st));
    const e2 = await rejects(b.readShortLink('#l=notthere.AAAAAAAAAAAAAAAAAAAAAA', st));
    const e3 = await rejects(b.readShortLink('#l=junk', st));
    const e4 = await rejects(b.readShortLink(`#l=${r.id}.${key}`, new Emu.ShortLinkStore({ fetch: server({ fail: 'network' }).fetch })));
    check('another key: "can\'t be opened"', e1 instanceof Emu.SessionError && /can't be opened/.test(e1.message), e1 && e1.message);
    check('a removed link: "removed, or never existed"', e2 instanceof Emu.SessionError && /removed, or never existed/.test(e2.message), e2 && e2.message);
    check('a damaged #l=: "damaged", no request', e3 instanceof Emu.SessionError && /damaged/.test(e3.message));
    check('offline: "Couldn\'t reach"', e4 instanceof Emu.SessionError && /Couldn't reach/.test(e4.message), e4 && e4.message);
    check('no #l= is no short link', (await b.readShortLink('#z=AQ', st)) === null && (await b.readShortLink('', st)) === null);
  }

  // ---------------- guardrails ----------------
  {
    const fake = (size, seed) => { const x = new Uint8Array(size); let v = seed; for (let i = 0; i < size; i++) { v = (v * 1103515245 + 12345) >>> 0; x[i] = v >>> 24; } return x; };
    const cases = [];
    const roms = new Emu.Session(); roms.switchMachine('dragon64'); roms.shownMachine.setRoms({ basic: fake(0x4000, 3) });
    cases.push(['on your own ROMs', roms, /Not for a moment on your own ROMs/]);
    const cart = new Emu.Session(); cart.switchMachine('coco'); cart.load('my copy.ccc', fake(0x2000, 5));
    cases.push(['with a cartridge', cart, /Not with a cartridge plugged in/]);
    const n9 = new Emu.Session(); n9.switchMachine('coco3'); n9.nitros9On = () => true;   // (NitrOS-9 itself: tests/nitros9-session.test.js)
    cases.push(['under NitrOS-9', n9, /Not for a NitrOS-9 moment/]);
    for (const [what, s, re] of cases) {
      const sv = server();
      const e = await rejects(s.shortLink(new Emu.ShortLinkStore({ fetch: sv.fetch })));
      check(`guardrail, ${what}: no short link, with its reason, and no request`, re.test(s.shortLinkRefusal() || '') && e instanceof Emu.SessionError && re.test(e.message) && sv.requests.length === 0, e && e.message);
    }
    check('guardrail, NitrOS-9: no long link of the moment either, with its reason', /NitrOS-9/.test(n9.longLinkRefusal() || ''));
    check('guardrail: the ROM and cartridge moments keep their long link', roms.longLinkRefusal() === null && cart.longLinkRefusal() === null);
    // too large: refused before anything is sent
    const big = new Emu.Session(); big.switchMachine('dragon64');
    const sv = server();
    const e = await rejects(big.shortLink(new Emu.ShortLinkStore({ fetch: sv.fetch }), { file: { bytes: fake(70 * 1024, 9) } }));
    check('a moment over 64 KB sealed: refused, no request, the long link offered', e instanceof Emu.SessionError && /too large for a short link.*long link works/.test(e.message) && sv.requests.length === 0, e && e.message);
    // a picture with too many colours goes without one, and says so
    const many = new Emu.Session(); many.switchMachine('dragon64');
    const f = new Emu.Frame(320, 240, 4 / 3);
    for (let i = 0; i < f.data.length; i++) f.data[i] = i % 20;
    for (let c = 0; c < 20; c++) f.table[c] = Emu.rgb(c * 12, 0, 0);
    many.shownMachine.render = () => f;
    const sv2 = server();
    const r = await many.shortLink(new Emu.ShortLinkStore({ fetch: sv2.fetch }));
    const body = sv2.requests[0].body;
    check('20 colours: no preview picture sent, and the page says why', !r.picture && /too many colours/.test(r.pictureNote) && body.length === 6 + body[1] + new DataView(body.buffer).getUint32(2 + body[1], true));
    const asked = await many.shortLink(new Emu.ShortLinkStore({ fetch: server().fetch }), { preview: false });
    check('the switch off: no picture and nothing to explain', !asked.picture && asked.pictureNote === null);
    const ok = new Emu.Session(); ok.switchMachine('coco3');
    const png = await ok.previewPicture();
    const h = Emu.readPngHeader(png);
    check('previewPicture: a 1200 x 630 indexed PNG of 16 colours or fewer, 32 KB or less', h.width === 1200 && h.height === 630 && h.colourType === 3 && h.palette.length <= 16 && png.length <= 32768, `${png.length} bytes`);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
