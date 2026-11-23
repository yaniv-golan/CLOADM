// Run: node tests/ask-popout.test.js
//
// "Ask Claude ↗" (js/ui/ask-popout.js): where the chat can't run because CLOADM is inside another site's page, the
// page offers a link that opens this moment top-level in a new tab with the chat. Here, without a browser:
//   - Session.claudeLink: the Share screen's link for the moment (the snapshot in the fragment) with app=claude and
//     never embed=1; the snapshot is this machine as it is now (decoded, its RAM read back); where the moment can't
//     be carried (NitrOS-9 runs, or the snapshot can't be shared) a fresh link on the same machine with app=claude;
//   - the embed's opt-in parameter askclaude=1 (js/config.js): read with embed=1, refused without it, written by
//     buildUrl only when asked for.
// The page itself (the app bar's link in a frame, the embed's chip, the new tab, its key) is the browser check's
// askPopout group.
const path = require('path');
const Emu = require('./load')();
const { synthNitrOs9Floppy } = require('./fixtures/nitros9-synth.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const BASE = 'https://cloadm.example/play/';

(async () => {
  const { parseUrlConfig, buildUrl } = await import(path.join(__dirname, '../js/config.js'));

  // ---- the link for a moment that can be carried ----
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  await s.ready();
  s.switchMachine('dragon64');
  for (let i = 0; i < 20; i++) s.shownMachine.runFrame();
  [0xA5, 0x5A, 0x13].forEach((v, i) => s.shownMachine.poke(0x3000 + i, v));
  const r = await s.claudeLink(BASE);
  const u = new URL(r.href);
  check('carried: the link opens /play/ with the machine and app=claude', r.carried === true && u.origin + u.pathname === BASE
    && u.searchParams.get('machine') === 'dragon64' && u.searchParams.get('app') === 'claude', r.href.slice(0, 120));
  check('carried: never embed=1 (nor any embed parameter)', !u.searchParams.has('embed') && !/embed/.test(u.search), u.search);
  check('carried: the snapshot rides in the fragment (#z=), as the Share screen\'s link does', /^#z=[A-Za-z0-9_-]+$/.test(u.hash), u.hash.slice(0, 20));
  const snap = await s.readLongLink(u.hash);
  check('carried: the snapshot is this machine (Dragon 64)', snap && snap.machine === 'dragon64', snap && snap.machine);
  // open it in another session: the moment is this one (the bytes poked above are in its RAM)
  const t = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  await t.ready();
  await t.openSnapshot(await t.readLongLink(u.hash));
  check('carried: opened elsewhere, the snapshot is this moment (the marker bytes are in RAM)',
    [0, 1, 2].map((i) => t.shownMachine.read(0x3000 + i)).join() === [0xA5, 0x5A, 0x13].join(), [0, 1, 2].map((i) => t.shownMachine.read(0x3000 + i)).join());
  // the same parameters as the Share screen's link, plus app=claude
  const share = new URL(await s.longLink(BASE));
  share.searchParams.set('app', 'claude');
  check('carried: the same query as the Share screen\'s link, with app=claude added', share.search === u.search, `${share.search} vs ${u.search}`);
  check('carried: the parsed link opens the chat and no embed', (() => { const c = parseUrlConfig(u.search); return c.app === 'claude' && c.embed === null && !c.errors.length; })(),
    JSON.stringify(parseUrlConfig(u.search).errors));

  // ---- a moment that can't be carried ----
  // NitrOS-9 running (a floppy boot of the synthetic image, as tests/chat-leaks.test.js does)
  const n9 = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  await n9.ready();
  n9.switchMachine('coco3');
  await n9.media.write('disks/n9.dsk', synthNitrOs9Floppy());
  await n9.bootNitros9('n9.dsk');
  check('(NitrOS-9 is running for the next checks)', n9.nitros9OnScreen === true);
  const f = await n9.claudeLink(BASE), fu = new URL(f.href);
  check('NitrOS-9: no snapshot (nothing in the fragment), carried is false', f.carried === false && fu.hash === '', f.href);
  check('NitrOS-9: a fresh CLOADM on the same machine with app=claude, no nitros9= and no embed',
    fu.searchParams.get('machine') === 'coco3' && fu.searchParams.get('app') === 'claude' && !fu.searchParams.has('nitros9') && !fu.searchParams.has('embed'), fu.search);
  // a snapshot that can't be shared (shareFile refuses it): the same fresh link rather than an error
  const bad = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  await bad.ready();
  bad.switchMachine('coco');
  bad.shareFile = async () => { throw new Emu.SessionError('This snapshot can\'t be shared: test'); };
  const b = await bad.claudeLink(BASE);
  check('a snapshot that can\'t be shared: a fresh link with app=claude, no error', b.carried === false && /app=claude/.test(b.href) && !/#/.test(b.href), b.href);
  // a fault that isn't the Session's refusal is not swallowed
  bad.shareFile = async () => { throw new TypeError('boom'); };
  let thrown = null;
  try { await bad.claudeLink(BASE); } catch (e) { thrown = e; }
  check('an unexpected fault in the snapshot is not turned into a fresh link', thrown instanceof TypeError, String(thrown));

  // ---- the embed's opt-in, askclaude=1 ----
  const on = parseUrlConfig('?embed=1&askclaude=1&machine=coco');
  check('askclaude=1 with embed=1: read as askClaude, no error', on.askClaude === true && on.embed === true && !on.errors.length, JSON.stringify(on.errors));
  const off = parseUrlConfig('?embed=1&machine=coco');
  check('embed=1 alone: askClaude is not set (the chip is off by default)', off.askClaude === null && !off.errors.length);
  const alone = parseUrlConfig('?askclaude=1');
  check('askclaude=1 without embed=1: refused, saying why', alone.askClaude === null && alone.errors.some((e) => /askclaude=1: only with embed=1/.test(e)), JSON.stringify(alone.errors));
  const junk = parseUrlConfig('?embed=1&askclaude=maybe');
  check('askclaude=maybe: 1 or 0', junk.askClaude === null && junk.errors.some((e) => /askclaude=maybe: 1 or 0/.test(e)), JSON.stringify(junk.errors));
  const built = buildUrl(BASE, { machine: 'coco', embed: true, askClaude: true });
  check('buildUrl writes askclaude=1 when asked for, and parsing it gives it back', /[?&]askclaude=1(&|$)/.test(built) && parseUrlConfig(new URL(built).search).askClaude === true, built);
  check('buildUrl writes no askclaude when not asked for', !/askclaude/.test(buildUrl(BASE, { machine: 'coco', embed: true })));

  console.log(`\n${n - fail}/${n} ask-popout checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
