// Run: node tests/link-freeze.test.js
//
// The share-link formats are FROZEN at 0.3.0 (AGENTS.md, "Formats are frozen"; docs/automation.md, "Share links"):
// every link and sealed object ever written must keep opening. This suite holds that, with golden links made once by
// tools/gen-link-fixtures.js and committed (tests/fixtures/links/), and the snapshot config rule.
//  * the fixtures' bytes: each file's SHA-256 is written below; a fixture that changes fails here (a new format gets a
//    NEW fixture beside the old ones, never a regenerated one);
//  * each fixture opens, in a fresh Session, to what it was made from, checked against values worked out by hand from
//    the program that made it (no ROMs: the moments ran on the built-in firmware; the program is opened on our
//    stand-in BASIC, tests/fixtures/basic-standin.js):
//      - a long link (#z=, byte 0 = 1) and a short link's sealed object (version 1, kind 1) holding the same moment: a
//        Dragon 64 whose 14-byte program at $7000 filled the text screen ($0400-$05FF) with "A" ($41) and loops at $700C;
//      - a long link (#z=, byte 0 = 2) and a sealed object (version 1, kind 2) holding a BASIC program: it lists as
//        written;
//      - (0.4) a long link (#z=, byte 0 = 3) and a sealed object (version 1, kind 3) holding a LIZA postcard: three
//        lines, which LIZA, started afresh on a Dragon 64, answers one by one;
//      - (0.4) a long link (#z=, byte 0 = 4) and a sealed object (version 1, kind 4) holding a program's source: the
//        moment's fill program as 9 lines of assembly, which builds to its crc here, waits for Run, then fills the screen;
//  * the snapshot config rule (Session.checkedSnapshot): a moment's config is the keys its model takes, each with one
//    of its values, and from a link mameCompat is off; anything else is damaged; what is remembered as the model's
//    config is only its own options, never mameCompat or hires.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Emu = require('./load')();
const { build } = require('./fixtures/basic-standin');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const DIR = path.join(__dirname, 'fixtures/links');
// the fixtures as committed: never change these, and never regenerate a fixture to match them
const GOLDEN = {
  'z1-moment.json': '7058b910a2320c7271ade44655d77e29856253a2df45c245bd45ca783ed81faf',
  'z2-program.json': 'de063a95fc3877c9cb1065c62dd9a5aecc8507aa33a19cb88672f8aca7c0a704',
  'sealed1-moment.json': '736e99c08f7442126f07817ca9ca7acbb7dca1d4df326eb2fd263142729c64c2',
  'sealed1-program.json': '4bd6ab9dca963fa61a513de6a297bee367a6d8a9baeed1ee01f1477598e8d0df',
  // 0.4: the LIZA postcard (byte 0 = 3; sealed kind 3)
  'z3-postcard.json': '4ff7fdf9b739adf8413626c66ef33720cd2060acdfb844bd2a10250a152c5dc3',
  'sealed1-postcard.json': '494fdebd07e25156db78e30e11164a3052ae4e8f2cdd39c777021c0d34c92b41',
  // 0.4: a program's source (byte 0 = 4; sealed kind 4)
  'z4-source.json': '616d5a43d9e160a2bfd1a06b270eda3fdbdefc03c1ed2942402fa25a0bbb7252',
  'sealed1-source.json': '1e308a579a07903a5cfffeb6ff2d5ebb69b74c938618b29c791721a187317f3f',
};
const POSTCARD = ['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC', 'YOU ARE A COMPUTER'];
const FILL = [0x8E, 0x04, 0x00, 0x86, 0x41, 0xA7, 0x80, 0x8C, 0x06, 0x00, 0x26, 0xF9, 0x20, 0xFE];
const LISTED = '10 REM GOLDEN\n20 FOR I=1 TO 3:PRINT "Hi";I:NEXT\n30 GOTO 20';
const fresh = (id = 'coco3') => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine(id, undefined, { menu: false }); return s; };
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
// a short link's store holding one sealed object, as s.cloadm.dev would serve it
const storeWith = (sealed) => { const st = new Emu.MemoryShortLinkStore(); st.links.set('golden01', { machine: 'dragon64', sealed: new Uint8Array(Buffer.from(sealed, 'base64url')), png: null, deleteToken: 'x' }); return st; };

// the moment as made: the screen all "A", the program at $7000, the CPU in its last loop
function momentChecks(label, s) {
  const m = s.shownMachine;
  const screen = Array.from({ length: 0x200 }, (_, i) => s.readByte(0x400 + i));
  const prog = Array.from({ length: FILL.length }, (_, i) => s.readByte(0x7000 + i));
  check(`${label}: a Dragon 64 on the built-in firmware`, m.id === 'dragon64' && !m.hasRom, m.id);
  check(`${label}: the text screen $0400-$05FF is all "A" ($41), as the program left it`, screen.every((b) => b === 0x41));
  check(`${label}: the program's 14 bytes at $7000`, prog.join() === FILL.join(), prog.map((b) => b.toString(16)).join(' '));
  s.runFrames(2);
  check(`${label}: it runs on, in the program's last loop (BRA * at $700C)`, m.cpu.pc === 0x700C, m.cpu.pc.toString(16));
  check(`${label}: the screen reads as 16 rows of 32 "A"`, s.screenText().slice(0, 16).every((r) => r.slice(0, 32) === 'A'.repeat(32)), JSON.stringify(s.screenText()[0]));
}
// the program as made: on the Dragon 64 with our stand-in BASIC, it lists as written
function programChecks(label, prog) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  for (const [k, v] of Object.entries(build(Emu, 'dragon64'))) s.roms.put('dragon64', k, v, `${k}.rom`);
  s.switchMachine('mc10', undefined, { menu: false });
  const r = s.openSharedProgram(prog);
  const rd = (a) => s.readByte(a), w = (a) => (rd(a) << 8) | rd(a + 1);
  check(`${label}: a Dragon 64 BASIC program of 3 lines, listed as written`, r.state === 'listed' && r.lines === 3 && s.shownMachine.id === 'dragon64'
    && Emu.listProgram(rd, w(0x19), 'dragon') === LISTED, JSON.stringify(r));
}

// the postcard as made: LIZA started afresh on a Dragon 64 and the three lines replayed, each answered on screen
function postcardChecks(label, s, pc) {
  s.postcards.open(pc, { kind: 'long' }, fs.readFileSync(path.join(__dirname, '../examples', s.postcards.fileFor(pc.machine))));
  s.postcards.skip();
  for (let i = 0; i < 3000 && s.arrivedFromLink && s.arrivedFromLink.postcard.state !== 'done'; i++) s.runFrames(1);
  const text = s.screenText().join('\n');
  check(`${label}: LIZA on a Dragon 64 replays it to the end, each line answered`, s.shownMachine.id === 'dragon64' && s.arrivedFromLink.postcard.state === 'done'
    && POSTCARD.every((l) => text.includes(`> ${l}`)), text.replace(/\s+/g, ' ').slice(-120));
}

// the source as made: fill.asm for the Dragon 64, 9 lines; opened, nothing runs; Run builds it to its crc and fills the
// screen with "A" ($0400-$05FF), the program's 14 bytes at $7000
function sourceChecks(label, s, card) {
  check(`${label}: fill.asm for a Dragon 64, 9 lines`, card.machine === 'dragon64' && card.name === 'fill.asm' && card.source.split('\n').length === 9, JSON.stringify(Object.assign({}, card, { source: undefined })));
  const a = s.sources.open(card, { kind: 'long' });
  s.runFrames(3);
  const screenA = () => Array.from({ length: 0x200 }, (_, i) => s.readByte(0x400 + i)).every((b) => b === 0x41);
  check(`${label}: it builds to its crc here, and nothing runs until Run`, a.state === 'ready' && s.shownMachine.id === 'dragon64' && !screenA());
  s.sources.run(card);
  s.runFrames(3);
  const prog = Array.from({ length: FILL.length }, (_, i) => s.readByte(0x7000 + i));
  check(`${label}: Run fills the screen with "A", the program at $7000 in its last loop`, screenA() && prog.join() === FILL.join() && s.shownMachine.cpu.pc === 0x700C, s.shownMachine.cpu.pc.toString(16));
}

(async () => {
  // ---- 1. the fixtures' bytes ----
  const names = fs.readdirSync(DIR).sort();
  check('the fixtures are the ones committed, no more and no fewer', JSON.stringify(names) === JSON.stringify(Object.keys(GOLDEN).sort()), names.join(' '));
  for (const [name, hash] of Object.entries(GOLDEN)) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex');
    check(`${name}: its bytes are the committed ones`, got === hash, got);
  }

  // the generator never overwrites a fixture: run now, it keeps all four and their bytes stay the committed ones.
  // It runs on a TEMPORARY COPY of the fixtures (a copy of the committed files): a test run must never be able to
  // rewrite the tracked fixtures, whatever state the generator's overwrite guard is in.
  {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-links-'));
    try {
      for (const n of Object.keys(GOLDEN)) fs.copyFileSync(path.join(DIR, n), path.join(tmp, n));
      const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../tools/gen-link-fixtures.js'), tmp], { encoding: 'utf8' });
      const kept = Object.keys(GOLDEN).filter((n) => new RegExp(`^${n.replace('.', '\\.')}: exists, kept`, 'm').test(out));
      const same = Object.entries(GOLDEN).every(([n, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, n))).digest('hex') === h);
      const untouched = Object.entries(GOLDEN).every(([n, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, n))).digest('hex') === h);
      check('tools/gen-link-fixtures.js refuses to overwrite: it keeps every existing fixture, and their bytes are unchanged', kept.length === Object.keys(GOLDEN).length && same && !/written/.test(out), out.trim().replace(/\n/g, ' | '));
      check('... and the committed fixtures were not touched by the run (they are opened from a temporary copy)', untouched);

      // ...and it really writes into the directory it is given: take one fixture out of the copy and it is written
      // back there, not into the tracked folder (which the check above would not catch on its own, as every tracked
      // file is present and so every one is kept)
      const missing = 'z2-program.json';
      fs.rmSync(path.join(tmp, missing));
      const out2 = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../tools/gen-link-fixtures.js'), tmp], { encoding: 'utf8' });
      check('tools/gen-link-fixtures.js writes into the directory it is given: a file missing from the copy is written there',
        new RegExp(`^${missing.replace('.', '\\.')}: written`, 'm').test(out2) && fs.existsSync(path.join(tmp, missing))
        && Object.keys(GOLDEN).filter((n) => n !== missing).every((n) => new RegExp(`^${n.replace('.', '\\.')}: exists, kept`, 'm').test(out2)),
        out2.trim().replace(/\n/g, ' | '));
      check('... and the tracked folder still has all of them, with the committed bytes', fs.readdirSync(DIR).sort().join() === Object.keys(GOLDEN).sort().join()
        && Object.entries(GOLDEN).every(([n, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, n))).digest('hex') === h));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- 2. each opens to what it was made from ----
  {
    const f = fixture('z1-moment.json');
    const bytes = Buffer.from(f.z, 'base64url');
    check('z1-moment: a long link whose byte 0 is 1 (a moment)', bytes[0] === 1 && f.format.linkByte0 === 1);
    const s = fresh();
    const snap = await s.readSnapshotLink(`#z=${f.z}`);
    s.openSnapshot(snap, { shared: true, link: { kind: 'long' } });
    momentChecks('z1-moment', s);
  }
  {
    const f = fixture('sealed1-moment.json');
    const sealed = Buffer.from(f.sealed, 'base64url');
    check('sealed1-moment: a sealed object of version 1, kind 1 (a moment)', sealed[0] === 1 && sealed[1] === 1);
    const s = fresh();
    const got = await s.readShortLink(`#l=golden01.${f.key}`, storeWith(f.sealed));
    check('sealed1-moment: opens as a moment', !!got.snap && !got.program && got.id === 'golden01');
    s.openSnapshot(got.snap, { shared: true, link: { kind: 'short', id: got.id } });
    momentChecks('sealed1-moment', s);
  }
  {
    const f = fixture('z2-program.json');
    const bytes = Buffer.from(f.z, 'base64url');
    check('z2-program: a long link whose byte 0 is 2 (a BASIC program)', bytes[0] === 2 && f.format.linkByte0 === 2);
    const prog = await fresh().readProgramLink(`#z=${f.z}`);
    check('z2-program: its machine and text', prog.machine === 'dragon64' && prog.text === LISTED, JSON.stringify(prog));
    programChecks('z2-program', prog);
  }
  {
    const f = fixture('sealed1-program.json');
    const sealed = Buffer.from(f.sealed, 'base64url');
    check('sealed1-program: a sealed object of version 1, kind 2 (a BASIC program)', sealed[0] === 1 && sealed[1] === 2);
    const got = await fresh().readShortLink(`#l=golden01.${f.key}`, storeWith(f.sealed));
    check('sealed1-program: opens as a program', !!got.program && !got.snap && got.program.text === LISTED, JSON.stringify(got.program));
    programChecks('sealed1-program', got.program);
  }

  {
    const f = fixture('z3-postcard.json');
    const bytes = Buffer.from(f.z, 'base64url');
    check('z3-postcard: a long link whose byte 0 is 3 (a LIZA postcard)', bytes[0] === 3 && f.format.linkByte0 === 3);
    const s = fresh();
    const pc = await s.postcards.read(`#z=${f.z}`);
    check('z3-postcard: its machine and its three lines', pc.machine === 'dragon64' && JSON.stringify(pc.lines) === JSON.stringify(POSTCARD), JSON.stringify(pc));
    postcardChecks('z3-postcard', s, pc);
  }
  {
    const f = fixture('sealed1-postcard.json');
    const sealed = Buffer.from(f.sealed, 'base64url');
    check('sealed1-postcard: a sealed object of version 1, kind 3 (a LIZA postcard)', sealed[0] === 1 && sealed[1] === 3);
    const s = fresh();
    const got = await s.readShortLink(`#l=golden01.${f.key}`, storeWith(f.sealed));
    check('sealed1-postcard: opens as a postcard', !!got.postcard && !got.snap && !got.program && JSON.stringify(got.postcard.lines) === JSON.stringify(POSTCARD), JSON.stringify(got.postcard));
    postcardChecks('sealed1-postcard', s, got.postcard);
  }

  {
    const f = fixture('z4-source.json');
    check('z4-source: a long link whose byte 0 is 4 (a program\'s source)', Buffer.from(f.z, 'base64url')[0] === 4 && f.format.linkByte0 === 4);
    const s = fresh();
    sourceChecks('z4-source', s, await s.sources.read(`#z=${f.z}`));
  }
  {
    const f = fixture('sealed1-source.json');
    const sealed = Buffer.from(f.sealed, 'base64url');
    check('sealed1-source: a sealed object of version 1, kind 4 (a program\'s source)', sealed[0] === 1 && sealed[1] === 4);
    const s = fresh();
    const got = await s.readShortLink(`#l=golden01.${f.key}`, storeWith(f.sealed));
    check('sealed1-source: opens as a source', !!got.source && !got.snap && !got.program && !got.postcard);
    sourceChecks('sealed1-source', s, got.source);
  }

  // ---- 3. the snapshot config rule ----
  {
    // a real moment (Dragon 64, built-in firmware), its config then changed as a damaged or hostile one would be
    const a = fresh('dragon64');
    const file = await a.shareFile();
    const base = file.moment.snap;
    const asLink = async (config) => `#z=${Buffer.from(await Emu.encodeLongLink(Object.assign({}, base, { config }), file.moment.meta)).toString('base64url')}`;
    const asFile = (config) => Emu.encodeSnapshot(Object.assign({}, base, { config }), file.moment.meta);
    const damagedLink = (e) => e instanceof Emu.SessionError && /This link's snapshot is damaged/.test(e.message);
    const damagedFile = (e) => e instanceof Emu.SessionError && /This snapshot is damaged/.test(e.message);
    const ok = Object.assign({}, base.config);
    check('(the moment\'s own config opens, from a link and from a file)', !!(await fresh().readSnapshotLink(await asLink(ok))) && !!(await fresh().readSnapshot(await asFile(ok))));
    for (const [what, config] of [['mameCompat on', Object.assign({}, ok, { mameCompat: true })], ['an option the model doesn\'t have (becker on a Dragon 64)', Object.assign({}, ok, { becker: true })],
      ['a value the option doesn\'t take (ram 48)', Object.assign({}, ok, { ram: 48 })], ['a value of the wrong type (ram "64")', Object.assign({}, ok, { ram: '64' })],
      ['a key no model has', Object.assign({}, ok, { turbo: 1 })], ['no config', null], ['a config that is an array', []]]) {
      check(`a link's moment with ${what}: damaged`, damagedLink(await rejects(fresh().readSnapshotLink(await asLink(config)))));
    }
    // (a file with no config at all is refused earlier, by the snapshot reader: "This CLOADM snapshot is incomplete.")
    const none = await rejects(fresh().readSnapshot(await asFile(null)));
    check('a snapshot file with no config: refused', none instanceof Emu.SessionError, none && none.message);
    for (const [what, config] of [['an option the model doesn\'t have', Object.assign({}, ok, { becker: true })], ['a value the option doesn\'t take', Object.assign({}, ok, { ram: 48 })]]) {
      const e = await rejects(fresh().readSnapshot(await asFile(config)));
      check(`a snapshot file with ${what}: damaged`, damagedFile(e), e && e.message);
    }
    // a short link's moment, the same rule
    const sealedBad = await Emu.sealMoment(await asFile(Object.assign({}, ok, { mameCompat: true })), Emu.SEALED_KIND.moment);
    check('a short link\'s moment with mameCompat on: damaged', damagedLink(await rejects(fresh().readShortLink(`#l=golden01.${sealedBad.key}`, storeWith(Buffer.from(sealedBad.sealed).toString('base64url'))))));
    // handed straight to openSnapshot from a link: refused, nothing switched, nothing remembered
    const r = fresh('coco3');
    const before = JSON.stringify(r.savedConfig('dragon64'));
    const e = (() => { try { r.openSnapshot(Object.assign({}, base, { config: Object.assign({}, ok, { mameCompat: true }) }), { shared: true, link: { kind: 'long' } }); return null; } catch (x) { return x; } })();
    check('openSnapshot of a link\'s moment with mameCompat on: refused; no switch; the Dragon 64\'s config not remembered', damagedLink(e) && r.shownMachine.id === 'coco3' && JSON.stringify(r.savedConfig('dragon64')) === before, e && e.message);
    // a person's own file may hold mameCompat and a Hi-Res interface (their own machine): it opens with them, and
    // what is remembered as the model's config is its own options only (never mameCompat or hires)
    const own = fresh('coco3');
    const coco = fresh('coco');
    coco.switchMachine('coco', { ram: 32, hires: 'tandy-right' }, { menu: false });
    const ownFile = await coco.snapshotFile();
    const ownSnap = await own.readSnapshot(ownFile.bytes);
    ownSnap.config = Object.assign({}, ownSnap.config, { mameCompat: true });
    own.openSnapshot(ownSnap);
    const saved = own.savedConfig('coco');
    check('a person\'s own file with mameCompat and a Hi-Res interface opens with them', own.shownMachine.config.mameCompat === true && own.shownMachine.config.hires === 'tandy-right');
    check('... and the model\'s remembered config is its own options only: ram kept, never mameCompat or hires', saved.ram === 32 && !('mameCompat' in saved) && !('hires' in saved), JSON.stringify(saved));
    // what was remembered before stays, under the moment's own options: the person's own Hi-Res interface for the CoCo
    // is kept when a link's moment (with none) switches to the CoCo, and the moment's RAM goes over the remembered RAM
    const kept = new Emu.Session({ store: Emu.memoryStore() });
    kept.switchMachine('coco', { ram: 16, hires: 'tandy-right' }, { menu: false });
    kept.switchMachine('coco3', undefined, { menu: false });
    const sender = fresh('coco');
    sender.switchMachine('coco', { ram: 64 }, { menu: false });
    const moment = await kept.readSnapshotLink(new URL(await sender.snapshotLink('https://cloadm.dev/play/')).hash);
    kept.openSnapshot(moment, { shared: true, link: { kind: 'long' } });
    const merged = kept.savedConfig('coco');
    check('a link\'s moment switching to the CoCo keeps the person\'s remembered Hi-Res interface, its RAM over the remembered RAM', kept.shownMachine.id === 'coco'
      && merged.hires === 'tandy-right' && merged.ram === 64 && !('mameCompat' in merged), JSON.stringify(merged));
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
