// Run: node tests/warmup.test.js
//
// The Display tab's "Old TV warm-up" (js/video/warmup.js, drawn by js/ui/warmup.js): the one-second timeline at each
// of its edges (a dot becoming a line by 150 ms, the line opening to full height over-bright by 450 ms, the picture
// fading from 40% to 100% by 1000 ms, then nothing), the 45 fps over 2 s rule, every case where it never plays, the
// setting (off by default, in a settings export, no link parameter), the Session's power-on event, and that a power
// cycle with the warm-up on runs the machine exactly as one with it off (the same frames). The browser check's
// `warmup` group checks the page: the overlay on a power cycle, gone by 1.1 s, absent in each excluded case, a key
// passing through, and a screenshot at 300 ms.
const path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

(async () => {
  const W = await import(path.join(__dirname, '..', 'js', 'video', 'warmup.js'));
  const { warmupFrame: f } = W;

  // ---- the timeline ----
  check('1.0 s long: 150 ms, 450 ms, 1000 ms', W.WARMUP_MS === 1000 && W.DOT_MS === 150 && W.OPEN_MS === 450);
  check('nothing before it starts or once it is over', f(-1) === null && f(1000) === null && f(1100) === null && f(NaN) === null);
  const d0 = f(0), d1 = f(149.9);
  check('0 ms: a dot (the line barely there), the picture hidden', d0.phase === 'dot' && d0.line <= 0.02 && d0.band === 0 && d0.picture === 0, JSON.stringify(d0));
  check('just before 150 ms: a line nearly across the screen, still no picture', d1.phase === 'dot' && d1.line > 0.99 && d1.band === 0 && d1.picture === 0, JSON.stringify(d1));
  let grows = true;
  for (let t = 0; t < 150; t += 5) if (f(t + 5).phase === 'dot' && f(t + 5).line < f(t).line) grows = false;
  check('0-150 ms: the dot only grows into the line', grows);
  const o0 = f(150), o1 = f(300), o2 = f(449.9);
  check('150 ms: the line across the whole width starts to open', o0.phase === 'open' && o0.line === 1 && o0.band === 0, JSON.stringify(o0));
  check('150-450 ms: it opens, over-bright', o1.phase === 'open' && o1.band > o0.band && o1.band < 1 && o1.bright > 0, JSON.stringify(o1));
  check('just before 450 ms: full height, still over-bright', o2.band > 0.999 && o2.bright > 0, JSON.stringify(o2));
  let opens = true;
  for (let t = 150; t < 445; t += 5) if (f(t + 5).band < f(t).band) opens = false;
  check('150-450 ms: it only opens', opens);
  const p0 = f(450), p1 = f(725), p2 = f(999.9);
  check('450 ms: the real picture at 40%, no white over it', p0.phase === 'fade' && near(p0.picture, 0.4) && p0.bright === 0 && p0.band === 1, JSON.stringify(p0));
  check('725 ms: halfway, 70%', near(p1.picture, 0.7), JSON.stringify(p1));
  check('just before 1000 ms: all but 100%', p2.picture > 0.999 && p2.picture <= 1, JSON.stringify(p2));

  // ---- the frame rate: 45 fps over 2 s ----
  const r = new W.FrameRate();
  for (let t = 0; t < 1990; t += 1000 / 60) r.tick(t);
  check('less than 2 s of history: not known to be slow', r.rate(1990) === null && !r.slow(1990));
  for (let t = 2000; t < 4000; t += 1000 / 60) r.tick(t);
  check('60 fps: not slow', !r.slow(4000) && r.rate(4000) >= 59, String(r.rate(4000)));
  const s30 = new W.FrameRate();
  for (let t = 0; t <= 4000; t += 1000 / 30) s30.tick(t);
  check('30 fps: slow', s30.slow(4000), String(s30.rate(4000)));
  const s46 = new W.FrameRate(), s44 = new W.FrameRate();
  for (let t = 0; t <= 4000; t += 1000 / 46) s46.tick(t);
  for (let t = 0; t <= 4000; t += 1000 / 44) s44.tick(t);
  check('46 fps is not slow, 44 is (the line at 45)', !s46.slow(4000) && s44.slow(4000), `${s46.rate(4000)} ${s44.rate(4000)}`);
  const gap = new W.FrameRate();
  for (let t = 0; t <= 2000; t += 1000 / 60) gap.tick(t);
  check('frames that stopped (a stall): slow', gap.slow(3500), String(gap.rate(3500)));

  // ---- when it never plays ----
  const ok = { on: true, view: 'crt', hash: '', start: null };
  const B = W.warmupBlocked;
  check('on, CRT, nothing else: it plays', B(ok) === null);
  const cases = [
    ['off (the default)', { on: false }, 'off'],
    ['the Sharp view', { view: 'sharp' }, 'view'],
    ['a shared moment (#z=)', { hash: '#z=AAAA' }, 'shared-link'],
    ['a short link (#l=)', { hash: '#l=abc.def' }, 'shared-link'],
    ['a program page (start=2048)', { start: '2048' }, 'program-page'],
    ['a program page (start=liza)', { start: 'liza' }, 'program-page'],
    ['a program page (start=minesweeper)', { start: 'minesweeper' }, 'program-page'],
    ['start=wyrmfire', { start: 'wyrmfire' }, 'program-page'],
    ['the arrival card', { arrival: true }, 'arrival'],
    ['?demo=1', { demo: true }, 'demo'],
    ['?embed=1', { embed: true }, 'embed'],
    ['Reduce motion', { reducedMotion: true }, 'reduced-motion'],
    ['Save data', { saveData: true }, 'save-data'],
    ['below 45 fps over 2 s', { slow: true }, 'slow'],
  ];
  for (const [name, c, why] of cases) check(`never with ${name}`, B(Object.assign({}, ok, c)) === why, String(B(Object.assign({}, ok, c))));
  check('start=welcome still plays (the landing page\'s menu, not a program page)', B(Object.assign({}, ok, { start: 'welcome' })) === null);
  check('a view hash (#library) still plays', B(Object.assign({}, ok, { hash: '#library' })) === null);

  // ---- the setting ----
  const store = Emu.memoryStore();
  const s = new Emu.Session({ store });
  s.switchMachine('dragon64');
  check('off by default', s.oldTvWarmup === false);
  const heard = [];
  s.on((ev) => heard.push(ev));
  s.setOldTvWarmup(true);
  check('turned on: stored, and a display event', s.oldTvWarmup && store.get('oldTvWarmup') === '1' && heard.includes('display'));
  const exp = s.exportSettings();
  check('in a settings export', exp.settings.oldTvWarmup === '1', JSON.stringify(exp.settings));
  const s2 = new Emu.Session({ store: Emu.memoryStore() });
  const imp = s2.importSettings(exp);
  check('taken back by an import', imp.applied.includes('oldTvWarmup') && s2.oldTvWarmup === true);
  check('a bad value is refused', s2.importSettings({ format: 'cloadm-settings', version: 1, settings: { oldTvWarmup: 'yes' } }).ignored.includes('oldTvWarmup'));
  const cfg = Emu.parseUrlConfig('?warmup=1&oldtv=1');
  check('no link parameter sets it', !Emu.URL_PARAMS.some((p) => /warm|oldtv/i.test(p)) && !('warmup' in cfg.display), JSON.stringify(Emu.URL_PARAMS));

  // ---- the power-on event ----
  heard.length = 0;
  s.powerCycle();
  check('Switch off and on: a poweron event', heard.filter((e) => e === 'poweron').length === 1, heard.join());
  heard.length = 0;
  s.switchMachine('coco');
  check('a machine switch: a poweron event', heard.filter((e) => e === 'poweron').length === 1, heard.join());
  heard.length = 0;
  s.reset();
  check('a Reset is not a power-on', !heard.includes('poweron'), heard.join());

  // ---- the machine is untouched: a power cycle with it on runs exactly the same frames as with it off ----
  const run = (on) => {
    const x = new Emu.Session({ store: Emu.memoryStore() });
    x.switchMachine('dragon64');
    x.setOldTvWarmup(on);
    x.powerCycle({ menu: false });
    const m = x.shownMachine;
    const out = [];
    for (let i = 0; i < 60; i++) { m.runFrame(); out.push(hash(m.render().data)); }
    return { frames: out.join(), cycle: m.cycle, pc: m.cpu.pc };
  };
  const hash = (a) => { let h = 2166136261; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
  const a = run(false), b = run(true);
  check('the same frames, cycles and PC with it on as off', a.frames === b.frames && a.cycle === b.cycle && a.pc === b.pc, `${a.cycle} ${b.cycle}`);

  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
