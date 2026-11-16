// The Display tab without a browser: the Session's display settings (validated, remembered,
// applied to every kind of machine) and the picture's size on the page (fitPicture). The page itself is
// exercised by tools/browser-check.js.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof Emu.SessionError && re.test(e.message); } };

// ---------------- settings ----------------
{
  const store = Emu.memoryStore();
  const s = new Emu.Session({ store });
  s.switchMachine('coco');
  check('defaults: CRT, phase 1 (MAME\'s default), curvature 35, glow 55, no integer scaling, 4:3, the main screen',
    JSON.stringify(s.display) === JSON.stringify({ view: 'crt', phase: 1, curvature: 35, glow: 55, integer: false, aspect: '4:3', screen: 'main' }));
  check('CRT: the CoCo shows artifact colours with the chosen phase', s.machine.vdg.artifact === 1);
  s.setDisplay({ phase: 2 });
  check('phase 2 reaches the VDG', s.machine.vdg.artifact === 2);
  s.setDisplay({ view: 'sharp' });
  check('Sharp: composite colour off', s.machine.vdg.artifact === 0);
  s.setDisplay({ curvature: 0, glow: 100, integer: true, aspect: 'fill' });
  // remembered: a new Session on the same store
  const s2 = new Emu.Session({ store });
  s2.switchMachine('coco');
  check('settings are remembered', JSON.stringify(s2.display) === JSON.stringify({ view: 'sharp', phase: 2, curvature: 0, glow: 100, integer: true, aspect: 'fill', screen: 'main' }));
  check('and applied to a new machine', s2.machine.vdg.artifact === 0);
  s2.setDisplay({ view: 'crt' });
  s2.switchMachine('mc10');
  check('the MC-10 takes the phase on a switch', s2.machine.vdg.artifact === 2 && s2.hasArtifactPhase);
  s2.switchMachine('dragon64');
  check('the Dragon 64 (PAL): composite on, no phase choice', s2.machine.vdg.artifact !== 0 && s2.machine.vdg.pal && !s2.hasArtifactPhase);
  s2.switchMachine('coco3');
  check('the CoCo 3: CRT shows the composite monitor, with artifact colours at the chosen phase', s2.machine.monitor === 'composite'
    && s2.machine.gime.artifact === 2 && s2.hasArtifactPhase);
  s2.setDisplay({ view: 'sharp' });
  check('the CoCo 3: Sharp shows the RGB monitor, no artifact colours', s2.machine.monitor === 'rgb' && s2.machine.gime.artifact === 0);
  s2.switchMachine('coco3p');
  check('the PAL CoCo 3: no NTSC phase choice', !s2.hasArtifactPhase);
  s2.switchMachine('coco3');
  let events = 0; s2.on((e) => { if (e === 'display') events++; });
  s2.setDisplay({ glow: 10 });
  check('a change emits a display event', events === 1);
  // errors
  check('unknown setting refused', throws(() => s2.setDisplay({ brightness: 3 }), /No display setting "brightness"/));
  check('bad values refused', throws(() => s2.setDisplay({ phase: 3 }), /not a valid value/) && throws(() => s2.setDisplay({ curvature: 101 }), /not a valid value/)
    && throws(() => s2.setDisplay({ view: 'tv' }), /not a valid value/) && throws(() => s2.setDisplay({ integer: 1 }), /not a valid value/)
    && throws(() => s2.setDisplay({ glow: 2.5 }), /not a valid value/) && throws(() => s2.setDisplay({ aspect: '16:9' }), /not a valid value/));
  check('a refused change changes nothing', s2.display.glow === 10 && s2.display.phase === 2);
  // a damaged store: each bad value falls back to its default, the good ones stay
  const bad = Emu.memoryStore();
  bad.set('display.settings', JSON.stringify({ view: 'tv', phase: 2, curvature: -4, glow: 'lots', integer: true, aspect: 'fill' }));
  const s3 = new Emu.Session({ store: bad }); s3.switchMachine('coco');
  check('a damaged stored value falls back to its default', JSON.stringify(s3.display) === JSON.stringify({ view: 'crt', phase: 2, curvature: 35, glow: 55, integer: true, aspect: 'fill', screen: 'main' }));
  const junk = Emu.memoryStore(); junk.set('display.settings', '{not json');
  const s4 = new Emu.Session({ store: junk }); s4.switchMachine('coco');
  check('an unreadable store gives the defaults', s4.display.view === 'crt' && s4.display.curvature === 35);
}

// the page before the Display tab stored only 'crt' or 'sharp' under 'display': taken over once, then removed
{
  const old = Emu.memoryStore(); old.set('display', 'sharp');
  const s = new Emu.Session({ store: old }); s.switchMachine('coco');
  check('the old "display" setting is carried over and removed', s.display.view === 'sharp' && s.display.phase === 1 && old.get('display') === null
    && JSON.parse(old.get('display.settings')).view === 'sharp' && s.machine.vdg.artifact === 0);
  const both = Emu.memoryStore(); both.set('display', 'sharp'); both.set('display.settings', JSON.stringify({ view: 'crt', glow: 20 }));
  const s2 = new Emu.Session({ store: both }); s2.switchMachine('coco');
  check('newer settings win over the old key, which is removed', s2.display.view === 'crt' && s2.display.glow === 20 && both.get('display') === null);
}

// the Dragon 64 Plus's second screen: the Display tab's "Screen" choice, which only that machine has
{
  const store = Emu.memoryStore();
  const s = new Emu.Session({ store });
  s.switchMachine('dragon64');
  check('a one-screen machine offers no second screen', !s.hasTwoScreens);
  s.setDisplay({ screen: 'plus' });       // accepted and remembered, but nothing to apply it to
  check('... and the setting does not reach it', s.machine.view === undefined && s.machine.render().width === Emu.MC6847.WIDTH);
  // (a fresh store: this one now remembers 'plus' for whatever opens next)
  const fresh = new Emu.Session({ store: Emu.memoryStore() });
  fresh.switchMachine('d64plus');
  check('the Dragon 64 Plus has two, and opens on the Dragon\'s own screen', fresh.hasTwoScreens && fresh.machine.view === 'vdg' && fresh.machine.render().width === 320);
  s.switchMachine('d64plus');
  check('a remembered "plus" is applied on the switch', s.machine.view === 'plus');
  s.setDisplay({ screen: 'plus' });
  check('choosing the 80-column screen changes what render() returns', s.machine.view === 'plus' && s.machine.render().width === 640 && s.machine.render().height === 264);
  s.setDisplay({ screen: 'main' });
  check('and back', s.machine.view === 'vdg' && s.machine.render().width === 320);
  s.setDisplay({ screen: 'plus' });
  // a new Session on the same store: remembered, and applied on the switch
  const s2 = new Emu.Session({ store }); s2.switchMachine('d64plus');
  check('the choice is remembered and applied when the machine opens', s2.display.screen === 'plus' && s2.machine.view === 'plus');
  // switching away and back keeps it
  s2.switchMachine('coco'); s2.switchMachine('d64plus');
  check('it survives a machine switch', s2.machine.view === 'plus');
  let e = null;
  try { s2.setDisplay({ screen: 'tv' }); } catch (err) { e = err; }
  check('an unknown screen is refused', e instanceof Emu.SessionError, e && e.message);
}

// ---------------- picture size ----------------
// The frames are 4:3 with 240 lines on every machine.
{
  const f = (o) => Emu.fitPicture(Object.assign({ aspect: 4 / 3, lines: 240 }, o));
  const eq = (r, w, h) => r.width === w && r.height === h;
  // 1000 x 600: limited by the height, 600 high, 800 wide
  check('4:3 in a wide area: as high as the area', eq(f({ areaW: 1000, areaH: 600 }), 800, 600), JSON.stringify(f({ areaW: 1000, areaH: 600 })));
  // 600 x 1000: limited by the width, 600 wide, 450 high
  check('4:3 in a tall area: as wide as the area', eq(f({ areaW: 600, areaH: 1000 }), 600, 450));
  // integer: 600 high fits 2 x 240 = 480 lines, so 640 x 480; 1000 x 800 fits 3 x 240 = 720 (960 wide fits)
  check('integer scaling: 2 display pixels per line', eq(f({ areaW: 1000, areaH: 600, integer: true }), 640, 480));
  check('integer scaling: 3 display pixels per line', eq(f({ areaW: 1000, areaH: 800, integer: true }), 960, 720));
  // too small for one: just fits
  check('integer scaling in an area under 240 high: the picture just fits', eq(f({ areaW: 300, areaH: 200, integer: true }), 266, 200));
  check('fill: the whole area', eq(f({ areaW: 1000, areaH: 600, fill: true }), 1000, 600));
  check('fill ignores integer scaling', eq(f({ areaW: 1000, areaH: 600, fill: true, integer: true }), 1000, 600));
}

// ---------------- the picture without its border (the chat on a phone) ----------------
// fitActive fits the frame's active area to the area and returns the whole frame's size at that scale (larger than
// the area, which clips it). The VDG's frame is 320 x 240 with its 256 x 192 picture area at (32, 24) (MC6847: 32
// border pixels a side, 24 lines above and below, js/chips/mc6847.js); the GIME's moves with the mode, so it has none.
{
  const eq = (r, w, h) => r.width === w && r.height === h;
  const vdg = Emu.createMachine('dragon64').render(), gime = Emu.createMachine('coco3').render();
  check('the VDG frame says where its picture area is; the GIME frame does not', JSON.stringify(vdg.active) === '{"x":32,"y":24,"width":256,"height":192}'
    && vdg.width === 320 && vdg.height === 240 && gime.active === null, JSON.stringify(vdg.active));
  const a = (o) => Emu.fitActive(Object.assign({ frame: vdg }, o));
  // 358 x 269 (a phone held upright): the 4:3 picture area is 358 x 268.5 -> 358 x 268; the frame is 1.25 times that
  // (320 / 256 and 240 / 192): 447.5 -> 448 by 335
  check('border cut off, upright phone: the picture area fills the width, the frame is 1.25 times it', eq(a({ areaW: 358, areaH: 269 }), 448, 335), JSON.stringify(a({ areaW: 358, areaH: 269 })));
  // 360 x 310 (held sideways, between the keyboard's halves): limited by the width, 360 x 270 -> 450 x 337.5 -> 338
  check('border cut off, sideways: 360 wide, 450 x 338 frame', eq(a({ areaW: 360, areaH: 310 }), 450, 338), JSON.stringify(a({ areaW: 360, areaH: 310 })));
  // a text row (8 frame lines) is then 8 x 335 / 240 = 11.2 px against 8 x 268.5 / 240 = 8.95 px for the whole frame
  check('a text row grows by a quarter', Math.abs(8 * a({ areaW: 358, areaH: 269 }).height / 240 - 11.17) < 0.01);
  // integer: 600 x 500 holds 2 x 192 lines of the picture area (450 / 192 = 2.3): 512 x 384, so 640 x 480
  check('integer scaling counts the picture area\'s lines', eq(a({ areaW: 600, areaH: 500, integer: true }), 640, 480));
  check('a frame without a picture area is fitted whole, as by fitPicture', eq(Emu.fitActive({ areaW: 358, areaH: 269, frame: gime }), 358, 268)
    && eq(Emu.fitActive({ areaW: 358, areaH: 269, frame: gime }), Emu.fitPicture({ areaW: 358, areaH: 269, aspect: gime.aspect, lines: gime.height }).width, 268));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
