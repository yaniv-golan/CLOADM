// Run: node tests/basic-share.test.js
//
// "Share your program" (js/ui/share.js's program mode, js/ui/arrival.js): a BASIC program in memory shared as
// its text, browser-free, no network, no ROMs. BASIC is our stand-in (tests/fixtures/basic-standin.js: BASIC's pointers
// for an empty program and OK on the screen, our own code), so real BASIC is not the oracle (AGENTS.md 4.6): the
// expected listings below are written out by hand, in the form LIST shows ([CBU p.B40-B41]: '?' is PRINT, keywords in
// capitals, a space after the line number), and are not computed by the code under test.
//
// What is proved:
//  * the card's condition, Session.sharedProgram: null with no BASIC ROM (the stub), with BASIC's pointers describing an
//    empty program, and on a machine whose pointers describe no program; the program's line count and LIST text once
//    one is in memory;
//  * the LIST round trip on the Dragon (dragon64), the CoCo (coco, coco3) and the MC-10: the sender's program ->
//    programLink -> readProgramLink -> openSharedProgram on a fresh machine of the sender's model in another Session:
//    the recipient's program bytes are the sender's, it lists as the hand-written listing, LIST is typed and RUN never
//    is; the same through a short link (programShortLink -> readShortLink), whose stored bytes hold no preview picture
//    and not the program's text in the clear;
//  * no BASIC ROM on the recipient's side: 'needs-roms' with the machine's name, the machine switched to, nothing
//    loaded; the same call once the ROMs are stored lists it;
//  * the limits: a program over load_basic's limit (65536 characters of listing), one with a byte that is not typable
//    (a graphics character in a string), and one with lower case outside a string (typing gives capitals) get the
//    reason "This program can't be shared as text: share the whole moment instead." and no link;
//  * the link format: byte 0 is 2 (js/media/snapshot.js PROGRAM_LINK_VERSION), a moment's reader refuses it in words,
//    a newer program format says so, a damaged one is damaged, and characters outside $20-$7E are refused;
//  * the preview: listingRows wraps at 32 and stops at 16 rows; textScreenFrame draws the VDG's own glyphs, inverse for
//    capitals (as BASIC writes them to the screen) and normal for lower case (hand-checked pixels of 'A' and 'a').
const Emu = require('./load')();
const { build } = require('./fixtures/basic-standin');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const BASE = 'https://cloadm.dev/play/';
const REFUSED = 'This program can\'t be shared as text: share the whole moment instead.';

// a Session on machine `id` with our stand-in BASIC in its sockets, booted to OK (roms: stored in the Session's ROM
// store, as a person's added ROMs are; otherwise set on the machine only)
function basicSession(id, { stored = true } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  if (stored) for (const [k, v] of Object.entries(build(Emu, id))) s.roms.put(id, k, v, `${k}.rom`);
  s.switchMachine(id, undefined, { menu: false });
  if (!stored) { s.shownMachine.setRoms(build(Emu, id)); s.shownMachine.reset(true); }
  for (let i = 0; i < 10; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  return s;
}
const programOf = (s, m = s.shownMachine) => {
  const d = Emu.DIALECTS[m.profile.lineage], rd = (a) => s.readByte(a, m), w = (a) => (rd(a) << 8) | rd(a + 1);
  const start = w(d.pointers.txttab), end = w(d.pointers.vartab);
  return { list: Emu.listProgram(rd, start, d), bytes: Array.from({ length: end - start }, (_, i) => rd(start + i)) };
};

// typed as a person would (lower case, '?'), and the listing LIST gives back, written by hand
const SOURCE = {
  dragon: '10 rem shared\n20 for i=1 to 3:? "Hi";i:next\n30 if a=1 then 20 else 40\n40 x=peek(1024):gosub 60\n50 end\n60 return\n',
  coco: '10 rem shared\n20 for i=1 to 3:? "Hi";i:next\n30 if a=1 then 20 else 40\n40 x=peek(1024):gosub 60\n50 end\n60 return\n',
  mc10: '10 rem shared\n20 for i=1 to 3:? "Hi";i:next\n30 if a=1 then 20\n40 x=peek(1024):gosub 60\n50 end\n60 return\n',
};
const LISTED = {
  dragon: '10 REM SHARED\n20 FOR I=1 TO 3:PRINT "Hi";I:NEXT\n30 IF A=1 THEN 20 ELSE 40\n40 X=PEEK(1024):GOSUB 60\n50 END\n60 RETURN',
  coco: '10 REM SHARED\n20 FOR I=1 TO 3:PRINT "Hi";I:NEXT\n30 IF A=1 THEN 20 ELSE 40\n40 X=PEEK(1024):GOSUB 60\n50 END\n60 RETURN',
  mc10: '10 REM SHARED\n20 FOR I=1 TO 3:PRINT "Hi";I:NEXT\n30 IF A=1 THEN 20\n40 X=PEEK(1024):GOSUB 60\n50 END\n60 RETURN',
};

(async () => {
  // ---- 1. the card's condition ----
  {
    const stub = new Emu.Session({ store: Emu.memoryStore() });
    stub.switchMachine('dragon64', undefined, { menu: false });
    check('no BASIC ROM (the stub): no program card', stub.sharedProgram() === null);
    const s = basicSession('dragon64');
    check('the stand-in boots to OK', s.bootStatus().state === 'ok');
    check('BASIC with an empty program: no program card', s.sharedProgram() === null);
    s.loadBasic(SOURCE.dragon);
    const p = s.sharedProgram();
    check('a program in memory: its line count and its LIST text (hand-written)', p && p.lines === 6 && p.text === LISTED.dragon && p.refusal === null, JSON.stringify(p));
    s.pokeBytes(0x1B, [0x30, 0x00]);   // VARTAB elsewhere: the pointers no longer describe the program
    check('BASIC\'s pointers not describing a program: no program card', s.sharedProgram() === null);
  }

  // ---- 2. the LIST round trip, long and short links ----
  for (const [id, family] of [['dragon64', 'dragon'], ['coco', 'coco'], ['coco3', 'coco'], ['mc10', 'mc10']]) {
    const a = basicSession(id);
    a.loadBasic(SOURCE[family]);
    const sent = programOf(a), p = a.sharedProgram();
    check(`${id}: the sender's program lists as written by hand`, sent.list === LISTED[family] && p && p.text === LISTED[family], JSON.stringify(sent.list));
    const url = await a.programLink(BASE, p);
    const hash = url.slice(url.indexOf('#'));
    const bytes = Buffer.from(hash.slice(3), 'base64url');
    check(`${id}: the long link is #z= with byte 0 = 2, and names the machine in its address too`, bytes[0] === 2 && new URL(url).searchParams.get('machine') === id, url.slice(0, 80));
    const prog = await a.readProgramLink(hash);
    check(`${id}: the link carries the machine and the text, nothing else`, prog && prog.machine === id && prog.text === LISTED[family] && Object.keys(prog).sort().join() === 'config,machine,text', JSON.stringify(prog));
    // the recipient: another browser, on another machine, with the stand-in stored for the sender's model
    const b = basicSession(id);
    b.switchMachine(id === 'mc10' ? 'dragon32' : 'mc10', undefined, { menu: false });
    const before = b.shownMachine;
    const r = b.openSharedProgram(prog);
    const m = b.shownMachine, got = programOf(b), typed = m.typist.queue.join('');
    check(`${id}: opened on a fresh ${id}: listed, the program's bytes are the sender's, and it lists the same`, r.state === 'listed' && r.lines === 6 && m !== before && m.id === id
      && got.list === LISTED[family] && got.bytes.join() === sent.bytes.join(), JSON.stringify(r));
    check(`${id}: LIST is typed, never RUN`, typed === 'LIST\r' && !/RUN/.test(typed), JSON.stringify(typed));
    // the short link: the same bytes, sealed; the store gets no picture and never the text in the clear
    const store = new Emu.MemoryShortLinkStore();
    const short = await a.programShortLink(store, p);
    const kept = store.links.get(short.id);
    // never in the clear: neither the text nor the program link's own bytes (its deflate payload) are in what is stored
    const plain = Buffer.from(bytes.subarray(1)), stored = Buffer.from(kept ? kept.sealed : []);
    check(`${id}: the short link stores the sealed program, no preview picture, the machine's id; neither the text nor the link's deflate payload is in it`,
      kept && kept.png === null && kept.machine === id && !stored.toString('latin1').includes('SHARED') && stored.indexOf(plain) < 0 && stored.indexOf(plain.subarray(0, 16)) < 0
      && stored.length === bytes.length + Emu.SEAL_OVERHEAD, short.url);
    // (#l=<id>.<key>: where the arrival page sends https://s.cloadm.dev/<id>#<key>)
    const opened = await b.readShortLink(`#l=${short.id}.${short.url.split('#')[1]}`, store);
    check(`${id}: readShortLink gives { program } for a program's short link`, opened && opened.program && !opened.snap && opened.program.text === LISTED[family] && opened.program.machine === id, JSON.stringify(opened && opened.program));
  }

  // ---- 3. no BASIC ROM on the recipient's side ----
  {
    const a = basicSession('mc10');
    a.loadBasic(SOURCE.mc10);
    const prog = await a.readProgramLink((await a.programLink(BASE)).replace(/^[^#]*/, ''));
    const b = new Emu.Session({ store: Emu.memoryStore() });
    b.switchMachine('dragon64', undefined, { menu: false });
    const r = b.openSharedProgram(prog);
    check('no ROMs: needs-roms, with the machine\'s name and the line count, on the sender\'s model running without ROMs',
      r.state === 'needs-roms' && r.name === 'MC-10' && r.lines === 6 && b.shownMachine.id === 'mc10' && !b.shownMachine.hasRom, JSON.stringify(r));
    for (const [k, v] of Object.entries(build(Emu, 'mc10'))) b.roms.put('mc10', k, v, `${k}.rom`);
    const again = b.openSharedProgram(prog);
    check('the ROMs added: the same call loads it and lists it', again.state === 'listed' && programOf(b).list === LISTED.mc10 && b.shownMachine.typist.queue.join('') === 'LIST\r', JSON.stringify(again));
    // the arrival, as the page's arrival card reads it (Session.arrivedFromLink, js/ui/arrival.js)
    const c = new Emu.Session({ store: Emu.memoryStore() });
    c.switchMachine('dragon64', undefined, { menu: false });
    c.openSharedProgram(prog, { kind: 'short', id: 'abcdefgh' });
    const w = c.arrivedFromLink;
    check('arrival without ROMs: recorded with the listing, the machine\'s name and the link (a short link\'s id)', w && w.basic && !w.basic.listed && w.basic.text === LISTED.mc10
      && w.basic.lines === 6 && w.basic.name === 'MC-10' && w.kind === 'short' && w.id === 'abcdefgh', JSON.stringify(w));
    c.personInput(c.shownMachine);
    check('a key on the machine while it waits for ROMs does not end the arrival (the card holds the listing)', !!c.arrivedFromLink && !c.arrivedFromLink.basic.listed);
    for (const [k, v] of Object.entries(build(Emu, 'mc10'))) c.roms.put('mc10', k, v, `${k}.rom`);
    c.openSharedProgram(prog, { kind: 'long' });
    const l = c.arrivedFromLink;
    check('arrival with ROMs: recorded as listed, with no listing text', l && l.basic.listed && l.basic.text === null && l.kind === 'long' && l.id === null, JSON.stringify(l));
    c.personInput(c.shownMachine);
    check('then the first key (RUN) ends it, as a moment\'s arrival', c.arrivedFromLink === null);
    c.openSharedProgram(prog);
    check('opened with no link (an API caller): no arrival is recorded', c.arrivedFromLink === null);
    const bad = (() => { try { b.openSharedProgram({ machine: 'zx81', config: {}, text: '10 END' }); return null; } catch (e) { return e; } })();
    check('a machine CLOADM doesn\'t have is refused in words', bad instanceof Emu.SessionError && /doesn't have/.test(bad.message), bad && bad.message);
  }

  // ---- 4. the limits ----
  {
    // over load_basic's limit, and nothing else: 300 lines of 34 RESTORE tokens, each line 242 characters or fewer
    // listed (within the 249 BASIC's line input takes), 12 KB in memory but over 65536 characters listed
    const s = basicSession('dragon32');
    const d = Emu.DIALECTS.dragon, tok = Emu.crunch('RESTORE', d)[0], start = 0x1E01;
    const lines = Array.from({ length: 300 }, (_, i) => ({ number: i + 1, bytes: Array(34).fill(tok) }));
    const bytes = Emu.buildProgram(lines, start), after = start + bytes.length;
    s.pokeBytes(start, Array.from(bytes));
    for (const p of [0x1B, 0x1D, 0x1F]) s.pokeBytes(p, [after >> 8, after & 0xFF]);
    const big = s.sharedProgram();
    check('over load_basic\'s limit: the card, its line count, the reason, no text', big && big.lines === 300 && big.text === null && big.refusal === REFUSED, JSON.stringify(big && { lines: big.lines, refusal: big.refusal }));
    const e = await rejects(s.programLink(BASE, big));
    check('over the limit: no link', e instanceof Emu.SessionError && e.message === REFUSED, e && e.message);
    const store = new Emu.MemoryShortLinkStore();
    check('over the limit: no short link either, and nothing stored', (await rejects(s.programShortLink(store, big))) instanceof Emu.SessionError && store.links.size === 0);
    // a graphics character in a string: not typable
    const g = basicSession('coco3');
    g.loadBasic('10 PRINT "A"');
    const at = 0x2601 + 4 + 3;   // link, line number, PRINT, space, quote: the A
    check('(the byte poked is the A)', g.readByte(at) === 0x41);
    g.pokeBytes(at, [0x8F]);
    const gp = g.sharedProgram();
    check('a byte that is not typable (a graphics character): the reason', gp && gp.lines === 1 && gp.text === null && gp.refusal === REFUSED, JSON.stringify(gp));
    // lower case outside a string: typing it would give capitals, so it would not come back the same
    const l = basicSession('mc10');
    l.loadBasic('10 A=1');
    l.pokeBytes(0x4346 + 4, [0x61]);   // the A of line 10, in lower case
    const lp = l.sharedProgram();
    check('lower case outside a string (it would type back in capitals): the reason', lp && lp.text === null && lp.refusal === REFUSED, JSON.stringify(lp));
  }

  // ---- 5. the link format ----
  {
    const raw = await Emu.encodeProgramLink({ machine: 'dragon64', config: { ram: 64 }, text: '10 END' });
    check('byte 0 is PROGRAM_LINK_VERSION, 2', raw[0] === 2 && Emu.PROGRAM_LINK_VERSION === 2 && Emu.isProgramLink(raw));
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(await new Response(new Blob([raw.subarray(1)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())));
    check('the payload is deflate-raw JSON { format: cloadm-basic, version: 1, machine, config, text }',
      JSON.stringify(json) === JSON.stringify({ format: 'cloadm-basic', version: 1, machine: 'dragon64', config: { ram: 64 }, text: '10 END' }), JSON.stringify(json));
    const moment = await rejects(Emu.decodeLongLink(raw));
    check('a moment\'s reader refuses a program link in words', moment instanceof Emu.SnapshotError && /holds a BASIC program/.test(moment.message), moment && moment.message);
    const pack = async (v) => { const p = new Uint8Array(await new Response(new Blob([new TextEncoder().encode(JSON.stringify(v))]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); const o = new Uint8Array(p.length + 1); o[0] = 2; o.set(p, 1); return o; };
    const s = new Emu.Session({ store: Emu.memoryStore() });
    const read = (bytes) => rejects(s.readProgramLink(`#z=${Buffer.from(bytes).toString('base64url')}`));
    const newer = await read(await pack({ format: 'cloadm-basic', version: 2, machine: 'dragon64', config: {}, text: '10 END' }));
    check('a newer program format says so', newer instanceof Emu.SessionError && /newer CLOADM \(program format 2/.test(newer.message), newer && newer.message);
    const damaged = (e) => e instanceof Emu.SessionError && /program is damaged/.test(e.message);
    check('cut short: damaged', damaged(await read(raw.subarray(0, raw.length - 3))));
    check('another format: damaged', damaged(await read(await pack({ format: 'cloadm-state', version: 1, machine: 'dragon64', config: {}, text: '10 END' }))));
    check('a character outside $20-$7E in the text: damaged', damaged(await read(await pack({ format: 'cloadm-basic', version: 1, machine: 'dragon64', config: {}, text: '10 PRINT "é"' }))));
    check('no config object: damaged', damaged(await read(await pack({ format: 'cloadm-basic', version: 1, machine: 'dragon64', config: [], text: '10 END' }))));
    // the config: exactly what shareConfig writes (the model's own options, never mameCompat or hires, each with one of
    // its values), or the link is damaged and nothing is switched or remembered
    const cfg = (machine, config) => pack({ format: 'cloadm-basic', version: 1, machine, config, text: '10 END' });
    for (const [what, machine, config] of [['mameCompat', 'dragon64', { mameCompat: true }], ['hires (a device in a port)', 'coco', { hires: 'tandy-right' }],
      ['an option the model doesn\'t have (becker on a Dragon 64)', 'dragon64', { becker: true }], ['a value the option doesn\'t take (48K)', 'coco', { ram: 48 }],
      ['a value of the wrong type ("64")', 'dragon64', { ram: '64' }]]) {
      check(`a config with ${what}: damaged`, damaged(await read(await cfg(machine, config))));
    }
    const fine = await s.readProgramLink(`#z=${Buffer.from(await cfg('coco', { cpu: '6309', ram: 32, becker: true, ssc: 'none' })).toString('base64url')}`);
    check('a config as shareConfig writes it is read', fine && fine.machine === 'coco' && fine.config.ram === 32 && fine.config.becker === true);
    // the review's repro: handed straight to openSharedProgram, mameCompat is refused, and the model's saved config and
    // a later switch are untouched
    const r = new Emu.Session({ store: Emu.memoryStore() });
    r.switchMachine('dragon64', undefined, { menu: false });
    const before = JSON.stringify(r.savedConfig('dragon64'));
    const e = (() => { try { r.openSharedProgram({ machine: 'dragon64', config: { mameCompat: true }, text: '10 END' }); return null; } catch (x) { return x; } })();
    r.switchMachine('dragon64', undefined, { menu: false });
    // handed in without a config (or with one that is not an object, or without its text): damaged, not a TypeError
    for (const [what, prog] of [['no config', { machine: 'dragon64', text: '10 END' }], ['a config that is an array', { machine: 'dragon64', config: [], text: '10 END' }],
      ['a null config', { machine: 'dragon64', config: null, text: '10 END' }], ['no text', { machine: 'dragon64', config: {} }]]) {
      const x = (() => { try { r.openSharedProgram(prog); return null; } catch (y) { return y; } })();
      check(`openSharedProgram with ${what}: refused as damaged (a SessionError), nothing switched`, damaged(x) && r.shownMachine.id === 'dragon64', x && `${x.name}: ${x.message}`);
    }
    check('openSharedProgram refuses mameCompat; the saved config and the next switch are untouched', damaged(e) && JSON.stringify(r.savedConfig('dragon64')) === before
      && !r.shownMachine.config.mameCompat, e && e.message);
    // and through a short link, as the arrival reads one
    const st = new Emu.MemoryShortLinkStore(), sealed = await Emu.sealMoment(await cfg('dragon64', { mameCompat: true }));
    const made = await st.create({ machine: 'dragon64', sealed: sealed.sealed });
    check('a short link whose program config has mameCompat: damaged', damaged(await rejects(s.readShortLink(`#l=${made.id}.${sealed.key}`, st))));
    check('a moment\'s #z= is not a program link (null: the moment\'s reader takes it)', await s.readProgramLink(`#z=${Buffer.from([1, 2, 3]).toString('base64url')}`) === null && await s.readProgramLink('#share') === null);
  }

  // ---- 6. the preview: what LIST shows first, in the machine's font ----
  {
    const rows = Emu.listingRows(`10 ${'X'.repeat(40)}\n${Array.from({ length: 30 }, (_, i) => `${i + 20} END`).join('\n')}`);
    check('listingRows: a 43-character line takes two rows (32 + 11), and it stops at 16 rows', rows.length === 16 && rows[0] === `10 ${'X'.repeat(29)}` && rows[1] === 'X'.repeat(11) && rows[2] === '20 END' && rows[15] === '33 END', JSON.stringify(rows.slice(0, 3)));
    const f = Emu.textScreenFrame(['Aa']);
    // 'A' in the VDG font [mc6847 FONT_SRC '040A11111F1111']: its first row (cell row 3) is 04 -> one pixel at x=4 of the 8-pixel cell
    const px = (x, y) => f.data[y * 256 + x];
    const rowA = Array.from({ length: 8 }, (_, x) => px(x, 3)), rowa = Array.from({ length: 8 }, (_, x) => px(8 + x, 3));
    check('textScreenFrame: 256 x 192; a capital is inverse (green, its stroke dark green); lower case is normal (its stroke green on dark green)',
      f.width === 256 && f.height === 192 && rowA.join() === '0,0,0,0,9,0,0,0' && rowa.join() === '9,9,9,9,0,9,9,9' && px(0, 0) === 0 && px(8, 0) === 9 && px(16, 0) === 0,
      `${rowA.join('')} ${rowa.join('')}`);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
