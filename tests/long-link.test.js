// The compact share-link form of a snapshot, '#z=' (js/media/snapshot.js encodeLongLink / decodeLongLink,
// Session.longLink / readLongLink):
//  * hand-built vectors whose bytes are written out here, not made by the code under test: a container in a deflate
//    "stored" block assembled byte by byte (RFC 1951 3.2.4), and the exact container the encoder must write
//  * round trips: the same snapshot back, every typed array and non-finite number, with the picture left out
//  * through the Session, on every model: the moment opened from a #z= link runs on as the original does
//  * links from earlier versions (#s=, base64url of a .cloadm file) still open, with their picture
//  * damaged, cut, oversized and newer links: refused with a message, never a crash
const zlib = require('zlib');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
function run(m, frames, pixelsFrom = 0) {
  let h = 0x811C9DC5;
  m.cpu.trace = (c) => { h = fnv(h, c.pc); h = fnv(h, c.a | 0); h = fnv(h, c.b | 0); h = fnv(h, c.x | 0); h = fnv(h, c.totalCycles); };
  for (let f = 0; f < frames; f++) { m.runFrame(); if (f >= pixelsFrom) { const px = m.render().data; for (let i = 0; i < px.length; i += 3) h = fnv(h, px[i]); } }
  m.cpu.trace = null;
  const mem = m.memoryArray();
  for (let i = 0; i < mem.length; i++) h = fnv(h, mem[i]);
  return h >>> 0;
}
// a deflate stream of one final stored block (RFC 1951 3.2.4: BFINAL=1, BTYPE=00, then LEN and its complement NLEN)
const stored = (data) => Buffer.concat([Buffer.from([0x01, data.length & 0xFF, data.length >> 8, ~data.length & 0xFF, (~data.length >> 8) & 0xFF]), Buffer.from(data)]);
const u32 = (n) => Buffer.from([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, n >>> 24]);
const container = (json, bin) => Buffer.concat([u32(Buffer.byteLength(json)), Buffer.from(json, 'utf8'), Buffer.from(bin)]);
const link = (box, version = 1) => new Uint8Array(Buffer.concat([Buffer.from([version]), stored(box)]));

(async () => {
  // ---------------- a hand-built link, decoded ----------------
  {
    const json = '{"format":"cloadm-state","version":4,"machine":"dragon64","name":"Dragon 64","taken":"2026-11-23T10:00:00.000Z",'
      + '"config":{"ram":64},"roms":{},"state":{"memory":{"$bin":"Uint8Array","o":0,"n":3},"words":{"$bin":"Uint16Array","o":3,"n":4},'
      + '"level":{"$num":"-Infinity"},"frame":null,"cpu":{"pc":49152}}}';
    // memory 01 02 03; words 0x1234 0x5678, little-endian: 34 12 78 56
    const bytes = link(container(json, [0x01, 0x02, 0x03, 0x34, 0x12, 0x78, 0x56]));
    const snap = await Emu.decodeLongLink(bytes);
    check('hand-built: the skeleton comes back as written', snap.machine === 'dragon64' && snap.config.ram === 64 && snap.taken === '2026-11-23T10:00:00.000Z' && snap.state.cpu.pc === 0xC000);
    check('hand-built: a Uint8Array from its offset and length', snap.state.memory instanceof Uint8Array && Array.from(snap.state.memory).join() === '1,2,3');
    check('hand-built: a Uint16Array at an odd offset, little-endian', snap.state.words instanceof Uint16Array && Array.from(snap.state.words).join() === [0x1234, 0x5678].join());
    check('hand-built: a non-finite number and the left-out picture', snap.state.level === -Infinity && snap.state.frame === null);
    check('hand-built: the arrays are copies, not views of the container', snap.state.words.byteOffset === 0 && snap.state.words.buffer.byteLength === 4);
    // the same container through Node's own deflate decodes the same: the format is plain RFC 1951
    const viaZlib = new Uint8Array(Buffer.concat([Buffer.from([1]), zlib.deflateRawSync(container(json, [1, 2, 3, 0x34, 0x12, 0x78, 0x56]), { level: 9 })]));
    const z = await Emu.decodeLongLink(viaZlib);
    check('hand-built: compressed by zlib (another compressor) reads the same', Array.from(z.state.words).join() === Array.from(snap.state.words).join() && z.state.level === -Infinity);
  }

  // ---------------- the encoder writes exactly the container the format describes ----------------
  {
    const snap = { format: 'cloadm-state', version: 4, machine: 'coco', config: { ram: 16 }, roms: { basic: 0x12345678 },
      state: { memory: Uint8Array.from([9, 8]), frame: Uint8Array.from([7, 7, 7]), q: Int16Array.from([-2]), t: NaN } };
    const bytes = await Emu.encodeLongLink(snap, { name: 'Color Computer', taken: 'T' });
    check('encoder: the first byte is the link version, 1', bytes[0] === 1 && Emu.LONG_LINK_VERSION === 1);
    const box = zlib.inflateRawSync(Buffer.from(bytes.subarray(1)));
    const json = '{"format":"cloadm-state","version":4,"machine":"coco","name":"Color Computer","taken":"T","config":{"ram":16},"roms":{"basic":305419896},'
      + '"state":{"memory":{"$bin":"Uint8Array","o":0,"n":2},"frame":null,"q":{"$bin":"Int16Array","o":2,"n":2},"t":{"$num":"NaN"}}}';
    const want = container(json, [9, 8, 0xFE, 0xFF]);   // -2 as a little-endian int16: FE FF
    check('encoder: deflate-raw of u32 length, the skeleton, then the arrays\' bytes (the picture left out)', box.equals(want), `${box.length} vs ${want.length}`);
    check('encoder: the snapshot given is not changed (its picture stays)', snap.state.frame.length === 3);
    const back = await Emu.decodeLongLink(bytes);
    check('round trip: NaN, an Int16Array and a missing share', Number.isNaN(back.state.t) && back.state.q[0] === -2 && !('share' in back));
  }

  // ---------------- every model: the Session's link, opened in a fresh Session ----------------
  for (const [id, config] of [['dragon32', {}], ['dragon64', {}], ['coco', {}], ['coco3', { ram: 128 }], ['mc10', {}], ['d64plus', {}]]) {
    const s = new Emu.Session();
    s.switchMachine(id, config);
    const m = s.shownMachine;
    for (let i = 0; i < 25; i++) m.runFrame();
    m.runCycles(m.frameBase + (m.frameCycles >> 2));
    m.poke(0x4000 & (m.memoryArray().length - 1), 0xA5);
    const file = await s.shareFile(new Date('2026-11-23T10:00:00Z'));
    const url = await s.snapshotLink('https://cloadm.dev/play/', file);
    const u = new URL(url);
    check(`${id}: the link is /play/ with the machine, the moment after #z=`, u.pathname === '/play/' && new URLSearchParams(u.search).get('machine') === id && /^#z=[A-Za-z0-9_-]+$/.test(u.hash), url.slice(0, 80));
    const old = `${url.split('#')[0]}#s=${Emu.toBase64Url(file.bytes)}`;
    check(`${id}: the #z= link is shorter than the #s= one`, url.length < old.length, `${url.length} vs ${old.length}`);
    const want = run(m, 12, 1);
    const b = new Emu.Session();
    b.switchMachine('dragon64');
    b.openSnapshot(await b.readSnapshotLink(u.hash));
    check(`${id}: opened from #z= in another Session, it runs on identically (instructions, cycles, frames after the first, memory)`, b.shownMachine.id === id && run(b.shownMachine, 12, 1) === want);
    // a link from an earlier version: the .cloadm file in base64url, picture and all
    const c = new Emu.Session();
    c.switchMachine('dragon64');
    c.openSnapshot(await c.readSnapshotLink(new URL(old).hash));
    check(`${id}: an older #s= link still opens, and runs on identically (its picture included)`, c.shownMachine.id === id && run(c.shownMachine, 12, 0) === run(Emu.restoreSnapshot(await Emu.decodeSnapshot(file.bytes), {}), 12, 0));
  }

  // ---------------- what the program pages and the Share screen measure: LIZA and 2048 on the built-in firmware ----------------
  {
    const fs = require('fs'), path = require('path');
    for (const what of ['liza', '2048']) {
      const s = new Emu.Session();
      s.switchMachine('dragon64');
      for (let i = 0; i < 60; i++) s.shownMachine.runFrame();
      if (what === 'liza') s.runLiza(fs.readFileSync(path.join(__dirname, '../examples', s.lizaFile)));
      else s.runGame(what, fs.readFileSync(path.join(__dirname, '../examples', s.gameFile(what))));
      for (let i = 0; i < 120; i++) s.shownMachine.runFrame();
      const f = await s.shareFile();
      const z = await s.snapshotLink('https://cloadm.dev/play/', f);
      const old = `${s.shareUrl('https://cloadm.dev/play/').split('#')[0]}#s=${Emu.toBase64Url(f.bytes)}`;
      // the design measured 50% (LIZA) and 64% (2048, whose memory compresses less): hold the line at 70% so a regression
      // in the form shows
      check(`${what}: the #z= link is at most 70% of the #s= one`, z.length <= 0.7 * old.length, `${z.length} vs ${old.length} characters`);
    }
  }

  // ---------------- refusals ----------------
  {
    const s = new Emu.Session();
    s.switchMachine('dragon64');
    const good = new URL(await s.snapshotLink('https://cloadm.dev/play/')).hash;
    const damaged = (e) => e instanceof Emu.SessionError && /This link's snapshot is damaged/.test(e.message);
    const cases = {
      'cut short': good.slice(0, good.length - 200),
      'not base64url': '#z=not*base64!',
      'one byte': '#z=AQ',
      'empty': '#z=',
      'version 200 (not a version a CLOADM writes)': '#z=' + Emu.toBase64Url(Uint8Array.from([200, ...Emu.fromBase64Url(good.slice(3)).subarray(1)])),
      'junk ("junk")': '#z=junk',
      'version 0': '#z=' + Emu.toBase64Url(Uint8Array.from([0, ...Emu.fromBase64Url(good.slice(3)).subarray(1)])),
      'not deflate': '#z=' + Buffer.from([1, 0xFF, 0xFF, 0xFF, 0xFF]).toString('base64url'),
      'a length past the end': '#z=' + Buffer.from(link(Buffer.concat([u32(1000), Buffer.from('{}')]))).toString('base64url'),
      'an array past the end': '#z=' + Buffer.from(link(container('{"format":"cloadm-state","version":4,"machine":"dragon64","config":{},"roms":{},"state":{"m":{"$bin":"Uint8Array","o":0,"n":9}}}', [1, 2]))).toString('base64url'),
      'an unknown array type': '#z=' + Buffer.from(link(container('{"format":"cloadm-state","version":4,"machine":"dragon64","config":{},"roms":{},"state":{"m":{"$bin":"Array","o":0,"n":1}}}', [1]))).toString('base64url'),
      'a Uint16Array of odd length': '#z=' + Buffer.from(link(container('{"format":"cloadm-state","version":4,"machine":"dragon64","config":{},"roms":{},"state":{"m":{"$bin":"Uint16Array","o":0,"n":3}}}', [1, 2, 3]))).toString('base64url'),
      'another format': '#z=' + Buffer.from(link(container('{"format":"other","version":4,"machine":"dragon64","config":{},"roms":{},"state":{}}', []))).toString('base64url'),
      'bad JSON': '#z=' + Buffer.from(link(container('{"format":', []))).toString('base64url'),
    };
    for (const [what, hash] of Object.entries(cases)) {
      const e = await rejects(s.readSnapshotLink(hash));
      check(`refused, as damaged: ${what}`, damaged(e), e ? e.message : 'accepted');
    }
    const newer = await rejects(s.readSnapshotLink('#z=' + Buffer.from(link(Buffer.from('x'), 2)).toString('base64url')));
    check('a link from a newer CLOADM says so, as a SessionError', newer instanceof Emu.SessionError && /newer CLOADM \(link format 2; this page reads 1\)/.test(newer.message), newer && newer.message);
    const future = await rejects(s.readSnapshotLink('#z=' + Buffer.from(link(container('{"format":"cloadm-state","version":99,"machine":"dragon64","config":{},"roms":{},"state":{}}', []))).toString('base64url')));
    check('a snapshot version from a newer CLOADM says so', future instanceof Emu.SessionError && /newer CLOADM \(format version 99/.test(future.message), future && future.message);
    const machine = await rejects(Emu.decodeLongLink(link(container('{"format":"cloadm-state","version":4,"machine":"zx81","config":{},"roms":{},"state":{}}', []))));
    check('a machine this CLOADM lacks: named', machine instanceof Emu.SnapshotError && /\(zx81\)/.test(machine.message), machine && machine.message);
    // a small link that unpacks to far more than any snapshot: stopped while it is unpacked
    const bomb = new Uint8Array(Buffer.concat([Buffer.from([1]), zlib.deflateRawSync(Buffer.alloc(4 << 20))]));
    const big = await rejects(Emu.decodeLongLink(bomb, { maxBytes: 1 << 20 }));
    check('a link that unpacks past the limit is refused', big instanceof Emu.SnapshotError && /far more than any CLOADM snapshot/.test(big.message), `${bomb.length} bytes; ${big && big.message}`);
    check('no #z= or #s= is no snapshot', (await s.readSnapshotLink('#zz=1')) === null && (await s.readSnapshotLink('#share')) === null && (await s.readSnapshotLink('')) === null);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
