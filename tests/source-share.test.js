// Run: node tests/source-share.test.js
//
// "Share your program and its source" (js/source-share.js; the link: js/media/snapshot.js, byte 0 = 4; sealed kind 4):
//  * the link: round trip (long and short), what it holds (the source, never the built bytes), sourceCrc worked out by
//    hand from its definition, the limits (64 KB of source, the name), a newer CLOADM's, damaged ones, a machine or
//    options CLOADM lacks;
//  * the sender's refusals: a build holding a run of the machine's ROM ("Not shared: the built program contains bytes of
//    your ROMs."), a source over 64 KB, a source that didn't assemble;
//  * the recipient: a fresh machine of the sender's model, the source not run (no auto-run); Run builds it and starts it
//    only when it builds to the link's crc; a tampered source or crc, or an INCLUDE this CLOADM can't read, is never run
//    ("This source builds differently in this CLOADM, so it won't run here. The code is in the Assembler to read.").
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Emu = require('./load')();
const SS = require('../js/source-share.js');
const { build } = require('./fixtures/basic-standin');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const BASE = 'https://cloadm.dev/play/';
// fills the text screen with "A", then loops
const FILL = '        ORG     $7000\nSTART   LDX     #$0400\n        LDA     #$41\nLOOP    STA     ,X+\n        CMPX    #$0600\n        BNE     LOOP\nDONE    BRA     DONE\n        END     START\n';
const session = (id = 'dragon64') => { const s = new Emu.Session({ welcomeMenu: false }); s.switchMachine(id, undefined, { menu: false }); return s; };
const examples = (n) => { const p = path.join(__dirname, '../examples', n); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const screenA = (s) => Array.from({ length: 0x200 }, (_, i) => s.readByte(0x400 + i)).every((b) => b === 0x41);

(async () => {
  // ---- sourceCrc, from its definition ----
  {
    const segs = [{ addr: 0x7000, data: Uint8Array.of(0x8E, 0x04) }, { addr: 0x0102, data: Uint8Array.of(9) }];
    const bytes = Buffer.from([0x70, 0x00, 0x00, 0x02, 0x8E, 0x04, 0x01, 0x02, 0x00, 0x01, 9, 0x70, 0x00, 1]);
    check('sourceCrc: CRC-32 of each segment (address, length, bytes) and the start address with a 1', Emu.sourceCrc(segs, 0x7000) === zlib.crc32(bytes), Emu.sourceCrc(segs, 0x7000).toString(16));
    const none = Buffer.from([0x70, 0x00, 0x00, 0x02, 0x8E, 0x04, 0x01, 0x02, 0x00, 0x01, 9, 0xFF, 0xFF, 0]);
    check('sourceCrc: ... FF FF 0 for a program with no start address', Emu.sourceCrc(segs, null) === zlib.crc32(none));
  }

  // ---- the link ----
  const s = session();
  const res = Emu.assemble(FILL, '6809');
  const card = s.sources.card({ source: FILL, name: 'fill.asm', res });
  check('the card: the machine, its options, the name, the source and its crc', card.machine === 'dragon64' && card.name === 'fill.asm' && card.source === FILL
    && card.crc === Emu.sourceCrc(res.segments, res.exec) && JSON.stringify(card.config) === JSON.stringify(s.shareConfig()), JSON.stringify(Object.assign({}, card, { source: undefined })));
  const bytes = await Emu.encodeSourceLink(card);
  check('the link\'s byte 0 is 4 (a program\'s source)', bytes[0] === 4 && Emu.SOURCE_LINK_VERSION === 4);
  const raw = JSON.parse(zlib.inflateRawSync(Buffer.from(bytes.subarray(1))).toString());
  check('what it holds: format cloadm-asm, version 1, machine, config, name, source, crc; no built bytes', JSON.stringify(Object.keys(raw)) === '["format","version","machine","config","name","source","crc"]'
    && raw.format === 'cloadm-asm' && raw.version === 1 && !Buffer.from(zlib.inflateRawSync(Buffer.from(bytes.subarray(1)))).includes(Buffer.from(res.segments[0].data)), JSON.stringify(Object.keys(raw)));
  const url = await s.sources.link(BASE, card);
  check('the long link: the machine\'s address with the source in #z=', /^https:\/\/cloadm\.dev\/play\/\?machine=dragon64.*#z=[A-Za-z0-9_-]+$/.test(url), url.slice(0, 80));
  const r = session('coco');
  const back = await r.sources.read(url.slice(url.indexOf('#')));
  check('round trip: read back as the same card', JSON.stringify(back) === JSON.stringify(card));
  check('... a moment\'s reader says it is a source, not a moment', /program's source, not a moment/.test((await rejects(Emu.decodeLongLink(bytes))).message));
  check('... the program and postcard readers pass it on (null)', await r.readProgramLink(url.slice(url.indexOf('#'))) === null && await r.postcards.read(url.slice(url.indexOf('#'))) === null);
  const store = new Emu.MemoryShortLinkStore();
  const short = await s.sources.shortLink(store, card);
  const id = short.url.split('/').pop().split('#')[0], key = short.url.split('#')[1];
  const kept = store.links.get(id);
  check('the short link: sealed (version 1, kind 4), no picture', !!kept && kept.sealed[0] === 1 && kept.sealed[1] === 4 && kept.png === null && Emu.SEALED_KIND.source === 4);
  const got = await r.readShortLink(`#l=${id}.${key}`, store);
  check('... opened with its key: the source', !!got.source && !got.snap && !got.program && !got.postcard && JSON.stringify(got.source) === JSON.stringify(card));

  // ---- limits, damaged, newer ----
  {
    const z = async (v) => `#z=${Buffer.concat([Buffer.from([4]), zlib.deflateRawSync(Buffer.from(JSON.stringify(v)))]).toString('base64url')}`;
    const good = { format: 'cloadm-asm', version: 1, machine: 'dragon64', config: {}, name: 'a.asm', source: 'X', crc: 1 };
    const err = async (v, re, what) => { const e = await rejects(r.sources.read(await z(v))); check(`refused: ${what}`, e instanceof Emu.SessionError && re.test(e.message), e && e.message); };
    check('a good one reads', !!(await r.sources.read(await z(good))));
    await err(Object.assign({}, good, { version: 2 }), /newer CLOADM \(source format 2; this page reads 1\)/, 'a newer source format: "made by a newer CLOADM"');
    await err(Object.assign({}, good, { source: 'X'.repeat(65537) }), /source is damaged/, 'a source over 64 KB');
    check('a source of exactly 64 KB reads', !!(await r.sources.read(await z(Object.assign({}, good, { source: 'X'.repeat(65536) })))));
    await err(Object.assign({}, good, { crc: -1 }), /source is damaged/, 'a crc that is not a 32-bit number');
    await err(Object.assign({}, good, { crc: undefined }), /source is damaged/, 'no crc');
    await err(Object.assign({}, good, { name: '../x.asm' }), /source is damaged/, 'a name with a slash');
    await err(Object.assign({}, good, { name: '' }), /source is damaged/, 'an empty name');
    await err(Object.assign({}, good, { machine: 'zx81' }), /machine this CLOADM doesn't have/, 'a machine CLOADM lacks');
    await err(Object.assign({}, good, { config: { ram: 3 } }), /source is damaged/, 'an option value the model doesn\'t have');
    await err(Object.assign({}, good, { config: { mameCompat: true } }), /source is damaged/, 'a comparison setting (never travels)');
    check('refused: a link cut short', (await rejects(r.sources.read((await z(good)).slice(0, 22)))) instanceof Emu.SessionError);
    const sealed = (await Emu.sealMoment(Uint8Array.of(1), Emu.SEALED_KIND.source)).sealed;
    sealed[1] = 5;
    check('a sealed object of kind 5: "made by a newer CLOADM"', /newer CLOADM/.test(throws(() => Emu.sealedHead(sealed)).message));
  }

  // ---- the sender's refusals ----
  {
    const big = `${FILL}${'; padding\n'.repeat(6600)}`;
    const e = throws(() => s.sources.card({ source: big, name: 'big.asm', res: Emu.assemble(big, '6809') }));
    check('a source over 64 KB: "Not shared: the source is larger than 64 KB."', e instanceof Emu.SessionError && e.message === 'Not shared: the source is larger than 64 KB.', e && e.message);
    check('a source that didn\'t assemble: refused', throws(() => s.sources.card({ source: 'BAD', name: 'x.asm', res: Emu.assemble(' FOO BAR', '6809') })) instanceof Emu.SessionError);
    // the ROM guard: our stand-in BASIC in the sockets, and a build that holds 16 bytes of it
    const w = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
    for (const [k, v] of Object.entries(build(Emu, 'dragon64'))) w.roms.put('dragon64', k, v, `${k}.rom`);
    w.switchMachine('dragon64', undefined, { menu: false });
    const rom = Object.values(w.shownMachine.roms).find(Boolean);
    let at = -1;
    for (let i = 0; i + 16 <= rom.length && at < 0; i++) if (new Set(rom.subarray(i, i + 16)).size > 4) at = i;
    const src = `        ORG $7000\nSTART   BRA START\n        FCB ${Array.from(rom.subarray(at, at + 16)).join(',')}\n        END START\n`;
    const re = throws(() => w.sources.card({ source: src, name: 'rom.asm', res: Emu.assemble(src, '6809') }));
    check('the ROM guard: a build holding 16 bytes of the machine\'s ROM: "Not shared: the built program contains bytes of your ROMs."', re instanceof Emu.SessionError && re.message === SS.SOURCE_TEXT.roms
      && SS.SOURCE_TEXT.roms === 'Not shared: the built program contains bytes of your ROMs.', re && re.message);
    check('... the same machine, a build of our own: shared', !!w.sources.card({ source: FILL, name: 'fill.asm', res }));
    // (64 KB of source deflates to well under the short link's 64 KB, so the rule is shown with a smaller limit)
    class Small extends Emu.Session { static SHORT_SEALED_MAX = 256; }
    const sm = new Small({ welcomeMenu: false });
    sm.switchMachine('dragon64', undefined, { menu: false });
    const tooBig = Object.assign({}, card, { source: Array.from({ length: 4000 }, (_, i) => String.fromCharCode(33 + ((i * 7919 + (i >> 3) * 31) % 90))).join('') });
    check('a source too large for a short link (its sealed bytes over the limit): the long link, saying so', await sm.sources.tooBigForShort(tooBig) && !(await sm.sources.tooBigForShort({ machine: 'dragon64', config: {}, name: 'a.asm', source: 'X', crc: 1 }))
      && (await rejects(sm.sources.shortLink(store, tooBig))).message === SS.SOURCE_TEXT.shortTooBig && !(await s.sources.tooBigForShort(tooBig)));
  }

  // ---- the recipient ----
  {
    const t = session('coco3');
    const a = t.sources.open(card, { kind: 'short', id: 'abcdefgh' });
    t.runFrames(30);
    check('arrival: a fresh Dragon 64, "fill.asm, 9 lines", ready; a short link\'s id kept', t.shownMachine.id === 'dragon64' && a.name === 'fill.asm' && a.lines === 9 && a.state === 'ready' && !!t.arrivedFromLink && t.arrivedFromLink.id === 'abcdefgh');
    check('the arrival\'s words', SS.SOURCE_TEXT.arrival('fill.asm', 9) === 'Someone sent you a program with its source: fill.asm, 9 lines. It\'s open in the Assembler; press Run to build and start it.');
    check('nothing runs until Run: the screen is not filled, the program is not in memory', !screenA(t) && t.readByte(0x7000) !== 0x8E);
    const msg = t.sources.run(card);
    t.runFrames(5);
    check('Run: built here and started; the screen fills with "A"; the arrival is over', /running at \$7000/.test(msg) && screenA(t) && t.arrivedFromLink === null, msg);
  }
  for (const [what, bad] of [['the source changed (the crc kept)', Object.assign({}, card, { source: FILL.replace('#$41', '#$42') })], ['the crc changed', Object.assign({}, card, { crc: (card.crc ^ 1) >>> 0 })]]) {
    const t = session('coco');
    const a = t.sources.open(bad, { kind: 'long' });
    const e = throws(() => t.sources.run(bad));
    t.runFrames(5);
    check(`tampered, ${what}: "builds differently", never run`, a.state === 'mismatch' && e instanceof Emu.SessionError && e.message === SS.SOURCE_TEXT.mismatch
      && SS.SOURCE_TEXT.mismatch === 'This source builds differently in this CLOADM, so it won\'t run here. The code is in the Assembler to read.' && t.readByte(0x7000) !== 0x8E && !screenA(t), e && e.message);
  }
  {
    // INCLUDE: only from examples/ (the page's reader); one it can't read builds differently and is never run
    const inc = '        ORG $3000\nSTART   BRA START\n        INCLUDE "liza-data.inc"\n        END START\n';
    const ires = Emu.assemble(inc, '6809', { include: examples });
    const icard = s.sources.card({ source: inc, name: 'inc.asm', res: ires });
    const t = session();
    check('INCLUDE from examples/: builds the same, Run starts it', ires.ok && t.sources.open(icard, { kind: 'long' }, examples).state === 'ready' && /running at \$3000/.test(t.sources.run(icard, examples)));
    const u = session();
    check('... an INCLUDE this CLOADM can\'t read (nothing outside examples/): builds differently, never run', u.sources.open(icard, { kind: 'long' }, () => null).state === 'mismatch'
      && throws(() => u.sources.run(icard, () => null)) instanceof Emu.SessionError);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
