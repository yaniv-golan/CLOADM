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
};
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

(async () => {
  // ---- 1. the fixtures' bytes ----
  const names = fs.readdirSync(DIR).sort();
  check('the fixtures are the four committed, no more and no fewer', JSON.stringify(names) === JSON.stringify(Object.keys(GOLDEN).sort()), names.join(' '));
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
      check('tools/gen-link-fixtures.js refuses to overwrite: it keeps every existing fixture, and their bytes are unchanged', kept.length === 4 && same && !/written/.test(out), out.trim().replace(/\n/g, ' | '));
      check('... and the committed fixtures were not touched by the run (they are opened from a temporary copy)', untouched);
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
