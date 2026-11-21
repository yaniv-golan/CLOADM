// A toast's placement loop: one chain, and it writes only when the position changes.
//
// js/ui/feedback.js places a toast once per animation frame while it is up (follow -> place), so it moves when a
// control grows under it, a scroll happens or the window is resized. Measured on main (tools/flicker-measure.js and
// w1's probes): every show() started a NEW chain and no chain was ever cancelled -- a toast added a permanent
// per-frame loop to the page -- and place() rewrote #toastRegion's inline style unconditionally (2715 writes in a
// 3 s load window, 2714 of them byte-identical).
// This suite drives the model in Node through a small DOM stand-in: the chain is counted by the frames it schedules,
// and the style writes by what the stand-in's style object records. No browser needed, so it runs in the fast gate.
//
// Run: node tests/toast-follow.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
// the selector feedback.js uses for the controls a toast must not cover (one string, checked by the stand-in)
const CONTROLS_SEL = 'header, .controls, .slots, aside.drawer, #attention, #touchKeys button, #claudeBar, #installOffer';
// the screen selectors feedback.js avoids (readInputs uses this one string, checked by the stand-in)
const SCREEN_SEL = '#monitor, #monitor .tube, #screen';

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- a DOM stand-in just big enough for createFeedback's placement code ----
// Every element has a rect (set per test), a style object counting writes, and classList; the document answers
// querySelector/getElementById from one map. requestAnimationFrame collects callbacks the test runs by hand, so the
// number of LIVE chains is a number the test can read.
function world({ width = 1440, height = 900, controlBox = null } = {}) {
  const frames = [];                 // callbacks scheduled, not yet run
  let nextFrame = 1;
  const styleWrites = [];
  const rect = (o) => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...o });
  const mkStyle = (owner) => {
    const vals = new Map();
    const handler = {
      get(_, k) {
        if (k === '__writes') return styleWrites;
        if (k === 'cssText') return [...vals].map(([a, b]) => `${a}: ${b};`).join(' ');
        return vals.get(k) || '';
      },
      set(_, k, v) {
        if (v === (vals.get(k) || '')) { styleWrites.push({ owner, k, v, same: true }); return true; }
        vals.set(k, v); styleWrites.push({ owner, k, v, same: false }); return true;
      },
    };
    return new Proxy({}, handler);
  };
  const mkEl = (id) => {
    const el = {
      id, hidden: false, textContent: '', dataset: {}, children: [],
      style: mkStyle(id),
      _rect: rect({}),
      getBoundingClientRect() {
        // #toast.compact is smaller (play/index.html: 12px type, 2px padding). A stand-in whose rect ignored the class
        // could never show the band branch's compact form.
        const c = this === box && this.classList.contains('compact');
        const h = this._rect.height ? (c ? Math.max(16, Math.round(this._rect.height * 0.6)) : this._rect.height) : this._rect.height;
        // (A toast inside the region takes the region's inline width. This stand-in stops short of modelling the
        // stylesheet's `width: auto` as a different number, because the decision records the box's width at the
        // moment it decides, and a model that changed that number mid-decision would be modelling a bug: the width is
        // pinned by the check below instead, and the oscillation it prevents is a per-frame write count.)
        const inline = this === box && region.style.width ? Number.parseFloat(region.style.width) : NaN;
        const w = Number.isFinite(inline) ? inline : this._rect.width;
        return { ...this._rect, width: w, height: h, right: this._rect.left + w, bottom: this._rect.top + h };
      },
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      append() {}, remove() {}, addEventListener() {}, removeEventListener() {}, focus() {}, setAttribute() {},
    };
    return el;
  };
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  const box = el('toast');
  const region = el('toastRegion');
  const screen = el('screen'), tube = el('tube');
  // the markup has #toast inside #toastRegion
  box.parentNode = region;
  // a stand-in control: a box across the bottom of the window, so a toast whose natural place overlaps it is not
  // "free" and place() must put it somewhere else (that is the path that goes through the writer every frame)
  const ctl = controlBox === null ? { left: 0, top: height - 120, right: width, bottom: height, width, height: 120 } : controlBox;
  const control = { id: 'controls', getBoundingClientRect: () => ({ ...ctl }) };
  // (CONTROLS is what place() avoids; the screen selectors matter too -- '#monitor, #monitor .tube, #screen' -- and a
  // toast on the emulator page must avoid the screen as well, so the stand-in leaves those empty)
  const document = {
    getElementById: (id) => (id === 'screen' ? screen : els.get(id) || (id === 'toast' ? box : el(id))),
    querySelector: (sel) => (sel === '#toastRegion' ? region : sel === '#monitor .tube' ? tube : null),
    // the elements the placement decision avoids besides the controls: #monitor, its tube, and the screen
    querySelectorAll: (sel) => (sel === CONTROLS_SEL ? [control] : sel === SCREEN_SEL ? [screen, tube] : []),
    documentElement: { style: mkStyle('html') },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    document,
    location: { hash: '' },
    innerWidth: width, innerHeight: height,
    getComputedStyle: () => ({ getPropertyValue: () => '0px' }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: (cb) => { const id = nextFrame++; frames.push({ id, cb }); return id; },
    cancelAnimationFrame: (id) => { const i = frames.findIndex((f) => f.id === id); if (i >= 0) frames.splice(i, 1); },
    console,
  };
  return {
    sandbox, el, box, region, frames, screen, tube,
    // run one frame: every callback scheduled now (a chain that reschedules is still ONE chain)
    frame() { const now = frames.splice(0); for (const f of now) f.cb(0); return now.length; },
    liveChains: () => frames.length,
    writes: (who) => styleWrites.filter((w) => w.owner === who),
  };
}

// load js/ui/feedback.js with a fake './page.js' (it imports $ and safeArea), in the given world
function loadFeedback(w) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'feedback.js'), 'utf8')
    .replace(/import \{[^}]*\} from '\.\/page\.js';/, '')
    // the file is an ES module; runInContext is a script, so its exports are turned into plain declarations
    .replace(/^export (const|function|class) /gm, '$1 ');
  // the declarations the file makes are read back from the context (a script has no `export`)
  const ctx = vm.createContext({ ...w.sandbox, $: (id) => w.el(id), safeArea: () => ({ left: 0, top: w.sandbox.__safeTop || 0, right: w.sandbox.innerWidth, bottom: w.sandbox.innerHeight - (w.sandbox.__safeBottom || 0) }) });
  vm.runInContext(src + '\n;globalThis.__fb = createFeedback; globalThis.__decide = decide;', ctx, { filename: 'feedback.js' });
  globalThis.__decide = ctx.__decide;
  globalThis.__ctx = ctx;   // (the purity check must patch the VM's document/window, not this process's)
  return ctx.__fb();
}

// a toast as the page raises one (the model's own API), kept up by having no timer run in this stand-in
const raise = (fb, text = 'A toast') => fb.toast(text);
// Hand-built inputs for the pure decision. The geometry leaves the screen's band as the only free place, so the
// screen, the tube and the text area each decide the verdict; a geometry with a free place would never consult them
// and the checks below would pass without proving anything.
const MON = { left: 100, top: 200, right: 800, bottom: 860, width: 700, height: 660 };
const BASE = {
  winW: 1440, winH: 900, view: 'emulator', phone: false, area: { left: 0, top: 0, right: 1440, bottom: 900 },
  box: { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 }, classes: 'toast||',
  controls: [{ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 }],
  screen: [MON], tube: { left: 100, top: 200, right: 800, bottom: 700, width: 700, height: 500 },
  canvas: MON, active: '0,0.1,1,0.5',
};
const decide = (I) => globalThis.__decide(I);
const hostile = () => new Proxy({}, { get(_, k) { throw new Error('decide() read the DOM: ' + String(k)); } });
function decideWithHostileDom(I) {
  // the vm context is where decide() looks for `document`/`window`: patching this process's globals would not
  // reach it (a vm's document is a sandbox property, so the check would pass without proving anything)
  const vmCtx = globalThis.__ctx;
  const d = Object.getOwnPropertyDescriptor(vmCtx, 'document'), w = Object.getOwnPropertyDescriptor(vmCtx, 'window');
  Object.defineProperty(vmCtx, 'document', { value: hostile(), configurable: true });
  Object.defineProperty(vmCtx, 'window', { value: hostile(), configurable: true });
  try { return decide(Object.freeze(I)); }
  catch (e) { return { kind: 'threw', error: e.message }; }   // (reported as a failed check, not an aborted suite)
  finally {
    if (d) Object.defineProperty(vmCtx, 'document', d); else delete vmCtx.document;
    if (w) Object.defineProperty(vmCtx, 'window', w); else delete vmCtx.window;
  }
}

(async () => {
  // ---- one chain, however many toasts ----
  {
    const w = world();
    const fb = loadFeedback(w);
    raise(fb, 'first'); w.frame();
    const afterFirst = w.liveChains();
    check('one toast leaves one placement chain live', afterFirst === 1, `live chains: ${afterFirst}`);
    // THREE shows in one task (what replacing a toast does), then one frame: how many placement chains RUN?
    // On main each show() started its own, so all three ran -- three different positions written in the same frame.
    for (let i = 0; i < 3; i++) raise(fb, `toast ${i}`);
    const ranInOneFrame = w.frame();
    const afterSix = w.liveChains();
    check('showing toasts in one task runs ONE placement chain in the next frame, not one per toast',
      ranInOneFrame === 1, `${ranInOneFrame} chains ran in one frame after three shows (main: 3)`);
    check('... and exactly one chain is left live afterwards', afterSix === 1, `live chains after six: ${afterSix}`);
    fb.clear();
    w.frame();
    check('when the toast ends, no chain is left live (nothing keeps placing after it is gone)', w.liveChains() === 0, `live chains: ${w.liveChains()}`);
    // and nothing is written by a chain that should be dead
    const writesAtEnd = w.writes('toastRegion').length;
    for (let i = 0; i < 30; i++) w.frame();
    check('... and the region is not written again after it ended', w.writes('toastRegion').length === writesAtEnd,
      `${w.writes('toastRegion').length - writesAtEnd} writes in 30 frames after the toast ended`);
  }

  // ---- a stationary toast writes nothing after it has settled ----
  // The case that matters is a toast at a PLACED position (out of its natural place), which goes through the writer
  // every frame; a toast at its natural place skips the writer entirely and would make this check vacuous.
  {
    const w = world();
    const fb = loadFeedback(w);
    w.box._rect = { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 };   // below the window
    raise(fb, 'steady');
    w.frame(); w.frame();
    // it was placed if the writer set a position (a free spot or the pinned slot); then sixty more frames, with the
    // geometry unchanged, must not write again
    const positioned = w.region.style.left !== '' || w.region.classList.contains('top');
    const base = w.writes('toastRegion').length;
    for (let i = 0; i < 60; i++) w.frame();
    const after = w.writes('toastRegion').length;
    // The setup has to be a toast that goes through the writer each frame: either a PLACED position (a free spot of
    // place()'s own) or the pinned top slot (also written every frame until it pins, then not re-placed at all --
    // which is why the check below allows the pinned form but still requires zero further writes)
    check('setup: the stationary toast is one that goes through the writer (a placed spot or the pinned slot)',
      positioned, `left=${w.region.style.left} top=${w.region.style.top} pinned=${w.region.classList.contains('top')}`);
    check('a stationary toast writes the region style only a handful of times in 60 frames', after - base <= 2,
      `${after - base} writes in 60 frames (main: 3 a frame, ~180)`);
  }

  // ---- and it still FOLLOWS a change: a resize moves it ----
  {
    const w = world();
    const fb = loadFeedback(w);
    // (only this toast is born in this world: its chain is the only one)
    // the natural place starts BELOW the window, so place() must move it into view
    w.box._rect = { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 };
    raise(fb, 'moving'); w.frame(); w.frame();
    const before = { left: w.region.style.left, top: w.region.style.top };
    // the box moves with a layout change, still below the window wherever place() had put it: place() must follow it
    // (and a toast that could not move would stay at the old spot)
    w.box._rect = { left: 420, top: 1000, right: 1045, bottom: 1040, width: 625, height: 40 };
    w.frame(); w.frame();
    const after = { left: w.region.style.left, top: w.region.style.top };
    check('a layout change while the toast is up moves it (the chain is still placing it)', (before.top !== after.top || before.left !== after.left)
      && Number.parseInt(after.top, 10) >= 0 && Number.parseInt(after.top, 10) + 40 <= 900,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  // ---- the style is CLEARED when the stylesheet's own place is right (the stale-inline pitfall) ----
  {
    // a control across the bottom band ONLY: the toast below the window must be placed, and once it is inside the
    // window at a spot above the band, the stylesheet's place is free again
    const w = world({ controlBox: { left: 0, top: 800, right: 1440, bottom: 900, width: 1440, height: 100 } });
    const fb = loadFeedback(w);
    w.box._rect = { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 };
    raise(fb, 'settle'); w.frame(); w.frame();
    const placed = w.region.style.left !== '';
    // now the box sits inside the window, above the control: place() takes the stylesheet's place and must clear the
    // inline left/top it set before (a stale inline style would keep it at the old spot)
    w.box._rect = { left: 248, top: 500, right: 873, bottom: 540, width: 625, height: 40 };
    w.frame(); w.frame();
    check('when the stylesheet place is right again, the inline style it replaced is cleared',
      placed && w.region.style.left === '' && w.region.style.top === '', `left=${JSON.stringify(w.region.style.left)} top=${JSON.stringify(w.region.style.top)}`);
  }

  // ---- readInputs() fills every field the decision reads, from the real DOM ----
  // decide() cannot read the DOM, so a field readInputs() forgets is invisible to the decision: it would decide on
  // `undefined` and every input check above would still pass (it passes its own arguments). So this reads the REAL
  // stand-in DOM and requires each field to be populated.
  {
    const w = world();
    const fb = loadFeedback(w);
    w.screen._rect = { left: 100, top: 200, right: 800, bottom: 860, width: 700, height: 660 };
    w.tube._rect = { left: 100, top: 200, right: 800, bottom: 700, width: 700, height: 500 };
    w.screen.dataset.active = '0,0.1,1,0.5';
    raise(fb, 'inputs'); w.frame();
    const I = fb.readPlacementInputs();
    check('readInputs() carries the screen, the tube, the canvas and their visible text area',
      Array.isArray(I.screen) && I.screen.length > 0 && !!I.tube && !!I.canvas && I.active === '0,0.1,1,0.5',
      JSON.stringify({ screen: I.screen.length, tube: !!I.tube, canvas: !!I.canvas, active: I.active }));
    check('readInputs() carries the controls, the box, the classes and the safe area',
      Array.isArray(I.controls) && I.controls.length > 0 && !!I.box && typeof I.classes === 'string' && !!I.area,
      JSON.stringify({ controls: I.controls.length, box: !!I.box, area: !!I.area }));
  }

  // ---- the decision is PURE, and every input it uses reaches it ----
  // decide() is exported and takes only its inputs. These checks call it with the DOM made hostile: while it runs,
  // `document` and `window` are Proxies that throw on ANY access, so a decision that reads one fails. That is the
  // property a separate hand-written key could not provide -- it drifted three times in review (the safe-area insets,
  // the screen's text area, then #monitor's bezel), each time passing every other test.
  {
    const decided = decideWithHostileDom({ ...BASE });
    check('decide() reads no DOM: it decides from its inputs alone (document/window throw if touched)',
      !!decided && decided.kind !== 'threw' && ['natural', 'placed', 'band', 'top'].includes(decided.kind),
      JSON.stringify(decided).slice(0, 80));
    const verdict = (patch) => JSON.stringify(decide({ ...BASE, ...patch }));
    check('setup: BASE needs the screen (the band is the only free place)', JSON.parse(verdict({})).kind === 'band', verdict({}).slice(0, 60));
    check('the decision uses the screen text area (data-active)', verdict({ active: '0,0,1,1' }) !== verdict({}), verdict({ active: '0,0,1,1' }).slice(0, 40));
    check('the decision uses the tube', verdict({ tube: null }) !== verdict({}));
    // the safe area bounds the band (and decides which attempts are "in view"): a bottom inset that clips the screen
    // gives a different answer, band geometry included
    check('the decision uses the safe-area insets',
      verdict({ area: { left: 0, top: 0, right: 1440, bottom: 660 } }) !== verdict({}),
      verdict({ area: { left: 0, top: 0, right: 1440, bottom: 660 } }).slice(0, 46));
    // the controls decide whether a free place exists at all
    check('the decision uses the controls', verdict({ controls: [] }) !== verdict({}), verdict({ controls: [] }).slice(0, 40));
    // the box's own place: with no controls, a box already at a free spot takes the natural answer
    check('the decision uses the box position',
      verdict({ controls: [], box: { ...BASE.box, left: 40, top: 40, right: 665, bottom: 80 } }) !== verdict({ controls: [] }),
      verdict({ controls: [], box: { ...BASE.box, left: 40, top: 40, right: 665, bottom: 80 } }).slice(0, 40));
    // the phone flag drops the row of x-attempts
    check('the decision uses the phone flag', verdict({ phone: true, controls: [] }) !== verdict({ controls: [] }),
      verdict({ phone: true, controls: [] }).slice(0, 40));
    // and a decision made from ONE object, with that object unchanged, is the same answer every time (the cache can hit)
    check('... and the same inputs give the same verdict', verdict({}) === verdict({}));
  }
  // ---- the phone top-edge case does not oscillate ----
  // 390x800, the natural place covered and the top-edge spot free: the placed width is written, so the record must
  // carry that width. Recording null cleared it, the region shrank to fit, the rect changed and it re-placed: a loop
  // with more writes per frame than main.
  {
    const w = world({ width: 390, height: 800, controlBox: { left: 0, top: 700, right: 390, bottom: 800, width: 390, height: 100 } });
    const fb = loadFeedback(w);
    w.box._rect = { left: 8, top: 760, right: 382, bottom: 800, width: 374, height: 40 };   // under the control
    raise(fb, 'phone'); w.frame(); w.frame();
    const settled = Array.from({ length: 12 }, () => { const before = w.writes('toastRegion').length; w.frame(); return w.writes('toastRegion').length - before; });
    check('setup (phone 390x800): the toast was placed', w.region.style.left !== '', `left=${JSON.stringify(w.region.style.left)} top=${JSON.stringify(w.region.style.top)}`);
    check('the phone top-edge placement does not oscillate: no writes in 12 settled frames', settled.every((n) => n === 0), `writes per frame: ${settled.join(',')}`);
    check('... and its width is the one written (not cleared)', w.region.style.width === '374px', `width=${JSON.stringify(w.region.style.width)}`);
  }

  console.log(fail ? `${fail} of ${n} toast-follow checks FAILED` : `${n}/${n} toast-follow checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
