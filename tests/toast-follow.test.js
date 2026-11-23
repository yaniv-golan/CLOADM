// A toast's placement loop: one chain, and it writes only when the position changes.
//
// js/ui/feedback.js places a toast once per animation frame while it is up (follow -> place), so it moves when a
// control grows under it, a scroll happens or the window is resized. Measured on main (tools/flicker-measure.js and
// direct probes of the page): every show() started a NEW chain and no chain was ever cancelled -- a toast added a permanent
// per-frame loop to the page -- and place() rewrote #toastRegion's inline style unconditionally (2715 writes in a
// 3 s load window, 2714 of them byte-identical).
// This suite drives the model in Node through a small DOM stand-in: the chain is counted by the frames it schedules,
// and the style writes by what the stand-in's style object records. No browser needed, so it runs in the fast gate.
//
// Run: node tests/toast-follow.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
// the selector feedback.js uses for the controls a toast must not cover (one string, checked by the stand-in)
// Read from the module itself, not retyped: a control added to feedback.js's CONTROLS must reach this stand-in, or the
// suite silently stops modelling the elements the decision avoids (it did: #tapeHud was added and this copy missed it).
const CONTROLS_SEL = /const CONTROLS = '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'feedback.js'), 'utf8'))[1];
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
  const classWrites = [];
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
      // A real element's className is its class list as a space-separated string, and readInputs() puts it in the
      // placement key (`classes`) beside the region's and the body's. Without it here the key's classes field was always
      // "undefined|undefined|", so a branch that cleared #toast.compact AFTER recording its key still matched -- the
      // stand-in could not see the class in the key at all (the same blind spot that hid the placed-cache miss below).
      get className() { return [...this.classList._s].join(' '); },
      getBoundingClientRect() {
        // #toast.compact is smaller (play/index.html: 12px type, 2px padding). A stand-in whose rect ignored the class
        // could never show the band branch's compact form.
        const c = this === box && this.classList.contains('compact');
        const h = this._rect.height ? (c ? Math.max(16, Math.round(this._rect.height * 0.6)) : this._rect.height) : this._rect.height;
        // A toast inside the region takes the region's inline width. The stylesheet's `width: auto` is not modelled as
        // a different number, because the decision records the box's width at the moment it decides.
        const inline = this === box && region.style.width ? Number.parseFloat(region.style.width) : NaN;
        const w = Number.isFinite(inline) ? inline : this._rect.width;
        // A toast INSIDE a region that has inline left/top IS MOVED by them, as the browser moves it. Without this a
        // placement loop that clears and re-applies the position every frame still read the same "natural" rect, so
        // the stand-in could not see the loop it was written to catch (a placed toast whose cache key never matched).
        const moved = this === box && region.style.left !== '' && region.style.top !== '';
        return {
          left: moved ? Number.parseFloat(region.style.left) : this._rect.left,
          top: moved ? Number.parseFloat(region.style.top) : this._rect.top,
          width: w, height: h,
          right: (moved ? Number.parseFloat(region.style.left) : this._rect.left) + w,
          bottom: (moved ? Number.parseFloat(region.style.top) : this._rect.top) + h,
        };
      },
      // classList models CHROMIUM, not a tidier abstract set (measured: 10 remove() calls of an absent class on an
      // element that has a class attribute give 10 attribute records; add() of a present one likewise; toggle(c, false)
      // gives 0). So add()/remove() ALWAYS count a mutation -- that is what a real page pays -- while toggle() counts one
      // only when the set actually changes. That is the difference the code must respect: a no-op remove()/add() per
      // frame is real churn in a browser, and a fake that dropped it would hide exactly that.
      // The element is bound as `el`, NOT taken from `this`: inside these methods `this` is the classList object, so
      // `this === box` was never true and every record was labelled '?' -- a filter on 'toastRegion' matched nothing and
      // the class-churn checks passed vacuously.
      classList: (() => { const own = () => (el === box ? 'toast' : (el === region ? 'toastRegion' : '?')); return { _s: new Set(),
        add(c) { this._s.add(c); classWrites.push({ owner: own(), k: 'add', v: c }); },
        remove(c) { this._s.delete(c); classWrites.push({ owner: own(), k: 'remove', v: c }); },
        toggle(c, on) {
          const want = on === undefined ? !this._s.has(c) : !!on;
          if (this._s.has(c) === want) return want;   // no change: a real toggle queues nothing
          if (want) this._s.add(c); else this._s.delete(c);
          classWrites.push({ owner: own(), k: 'toggle', v: c });
          return want;
        },
        contains(c) { return this._s.has(c); } }; })(),
      querySelector() { return null; },
      querySelectorAll() { return []; },
      append() {}, remove() {}, addEventListener() {}, removeEventListener() {}, focus() {}, setAttribute() {},
      // what the stage's toast rules read (UX R45: is the box hovered or focused; the second line is emptied when a
      // toast ends): nothing here is hovered, and nothing has the focus (document.activeElement is null)
      matches() { return false; }, contains(x) { return x === this; }, replaceChildren() {},
    };
    return el;
  };
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  const box = el('toast');
  const region = el('toastRegion');
  const screen = el('screen'), tube = el('tube'), monitor = el('monitor');
  // the markup has #toast inside #toastRegion
  box.parentNode = region;
  // a stand-in control: a box across the bottom of the window, so a toast whose natural place overlaps it is not
  // "free" and place() must put it somewhere else (that is the path that goes through the writer every frame). An
  // ARRAY is several controls: the band scenario needs every free place covered at once, which one box cannot do.
  const ctls = controlBox === null ? [{ left: 0, top: height - 120, right: width, bottom: height, width, height: 120 }]
    : Array.isArray(controlBox) ? controlBox : [controlBox];
  const control = { id: 'controls', getBoundingClientRect: () => ({ ...ctls[0] }) };
  const controls = ctls.map((c, i) => (i === 0 ? control : { id: 'controls' + i, getBoundingClientRect: () => ({ ...c }) }));
  // (CONTROLS is what place() avoids; the screen selectors matter too -- '#monitor, #monitor .tube, #screen' -- and a
  // toast on the emulator page must avoid the screen as well, so the stand-in leaves those empty)
  const document = {
    getElementById: (id) => (id === 'screen' ? screen : els.get(id) || (id === 'toast' ? box : el(id))),
    querySelector: (sel) => (sel === '#toastRegion' ? region : sel === '#monitor .tube' ? tube : null),
    // the elements the placement decision avoids besides the controls, for the selector readInputs uses:
    // '#monitor, #monitor .tube, #screen'. THREE distinct elements -- the monitor's own box, its tube and the screen --
    // which is what the page has. With only two of them here, a change to #monitor was indistinguishable from a change to
    // #screen, so `screen`'s own contribution to the key was untested.
    querySelectorAll: (sel) => (sel === CONTROLS_SEL ? controls : sel === SCREEN_SEL ? [monitor, tube, screen] : []),
    documentElement: { style: mkStyle('html') },
    activeElement: null,
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
    sandbox, el, box, region, frames, screen, tube, monitor,
    // the control boxes, so a test can move or grow one under a toast (the "a control grows under it" case)
    controls: ctls,
    // run one frame: every callback scheduled now (a chain that reschedules is still ONE chain)
    frame() { const now = frames.splice(0); for (const f of now) f.cb(0); return now.length; },
    liveChains: () => frames.length,
    writes: (who) => styleWrites.filter((w) => w.owner === who),
    classWrites: (who) => classWrites.filter((w) => w.owner === who),
  };
}

// load js/ui/feedback.js with a fake './page.js' (it imports $ and safeArea), in the given world
function loadFeedback(w) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'feedback.js'), 'utf8')
    .replace(/import \{[^}]*\} from '\.\/page\.js';/, '')
    // the file is an ES module; runInContext is a script, so its exports are turned into plain declarations
    .replace(/^export (const|function|class) /gm, '$1 ');
  // the declarations the file makes are read back from the context (a script has no `export`)
  // `innerWidth`/`innerHeight` follow `w.sandbox` LIVE, like the browser's do: a test that resizes the window
  // (crossing the 700 px phone threshold) must change what the running module reads. Spreading w.sandbox put a copy of
  // the numbers in the context, so a resize there was invisible to the code under test.
  const ctx = vm.createContext({ ...w.sandbox,
    get innerWidth() { return w.sandbox.innerWidth; },
    get innerHeight() { return w.sandbox.innerHeight; },
    $: (id) => w.el(id),
    // a fixed safe area may be pinned for a test that must change ONLY the phone flag (`__safeFixed`), since the real
    // one is derived from the window size and would change too
    safeArea: () => w.sandbox.__safeFixed || ({ left: 0, top: w.sandbox.__safeTop || 0, right: w.sandbox.innerWidth, bottom: w.sandbox.innerHeight - (w.sandbox.__safeBottom || 0) }) });
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
  phone: false, area: { left: 0, top: 0, right: 1440, bottom: 900 },
  box: { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 }, classes: 'toast||',
  controls: [{ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 }],
  screen: [MON], tube: { left: 100, top: 200, right: 800, bottom: 700, width: 700, height: 500 },
  canvas: MON, active: '0,0.1,1,0.5',
};
const decide = (I) => globalThis.__decide(I);
// ONE SET OF INPUTS PER ARM of decide(), so the purity guards provably execute every branch (the guards once ran
// only BASE, which takes the band arm, so a global read in the `if (at)` arm -- the ordinary natural/placed path --
// passed both). `ARM_INPUTS` below is what the guards iterate; the checks assert each entry's arm, so an entry that
// silently stops reaching its arm fails rather than guards nothing.
//   natural: no controls, no screen, a box already at a free spot -> { kind: 'natural' }
//   placed:  no controls, no screen, a box below the window  -> { kind: 'placed' } (the desktop scan picks a spot)
//   band:    BASE (a control covering everything; only the band under the screen's text is free)
//   top:     everything covered and no band (no screen/tube/canvas) -> { kind: 'top' }
const ARM_INPUTS = {
  natural: { ...BASE, controls: [], screen: [], tube: null, canvas: null, active: '',
    box: { left: 40, top: 40, right: 665, bottom: 80, width: 625, height: 40 } },
  placed: { ...BASE, controls: [], screen: [], tube: null, canvas: null, active: '',
    box: { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 } },
  band: { ...BASE },
  top: { ...BASE, screen: [], tube: null, canvas: null, active: '',
    controls: [{ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 }],
    box: { left: 0, top: 900, right: 625, bottom: 940, width: 625, height: 40 } },
};
// A context with NOTHING but the inputs: `decide` is compiled into a vm sandbox that has no document, no window, no
// innerWidth, no location, no Date, no module state and no captured variables. Anything it reaches for that is not in
// its `I` argument is a ReferenceError, so the guard catches a bare global that document/window proxies never see (the
// earlier version trapped only document/window and let `innerWidth`, `Date.now()`, `location.hash`, `safeArea()` and a
// module counter through: four mutants, all green). `decide` and the `decideWithHostileDom` check below complement
// each other: hostile-dom traps property ACCESS on document/window (a read of `document.body`), this traps every other
// global.
const DECIDE_SRC = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'feedback.js'), 'utf8');
  const m = /^export function decide\(I\) \{[\s\S]*?\n\}/m.exec(src);
  if (!m) throw new Error('tests/toast-follow: could not find decide() in js/ui/feedback.js (renamed?)');
  return m[0].replace(/^export /, '');
})();
let isolatedDecide = null;
function buildIsolatedDecide() {
  // `vm.runInContext` evaluates a script, so the function is declared and then read back. The sandbox carries the
  // DECLARATION only; every call gets a fresh `I`. A fresh context has the ECMAScript intrinsics (Object, Array,
  // Number, Math, JSON), which are the language and not the page, so those stay -- but `Date` and `Math.random` are
  // non-determinism, so both are replaced with throwers: a pure decision must be the same answer for the same inputs.
  const ctx = vm.createContext({});
  vm.runInContext(`
    const __nope = (what) => { throw new Error('decide() used ' + what + ': a decision must be deterministic'); };
    globalThis.Date = new Proxy(function () {}, { get: (_, k) => () => __nope('Date.' + String(k)), construct: () => __nope('new Date') });
    Math.random = () => __nope('Math.random');
  `, ctx, { filename: 'decide-sandbox.js' });
  vm.runInContext(`${DECIDE_SRC}\n;globalThis.__decide = decide;`, ctx, { filename: 'decide-isolated.js' });
  return (I) => {
    ctx.__seen = { arg: I };
    try { return { ok: true, value: vm.runInContext('__decide(__seen.arg)', ctx, { timeout: 1000 }) }; }
    catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
  };
}
const isolated = (I) => isolatedDecide(I);
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
    // and its CLASS ATTRIBUTE, which a real browser writes even for a no-op remove()/add(). This is its own
    // count because the style budget above cannot see it: `placedAt` -> dropClass('top') runs every cached frame.
    const clsBase = w.classWrites('toastRegion').length;
    for (let i = 0; i < 60; i++) w.frame();
    check('... and a placed toast queues no class mutation on the region in 60 more frames (a pinned toast has not gone)',
      w.classWrites('toastRegion').length === clsBase, `${w.classWrites('toastRegion').length - clsBase} class writes in 60 frames`);
  }

  // ---- the class churn a pinned toast and an error toast can leave behind ----
  // Both defects needed a toast BEFORE the stationary one, and neither showed in a write count:
  //   1. after any pinned toast, the region carries class="top"; every later placed toast re-applies placedAt, whose
  //      dropClass('top') was an unconditional remove() -> one class mutation per frame in a real browser (0 when it is a
  //      silent toggle).
  //   2. after any error toast, #toast carries class="error"; a later natural toast re-applied by reapply(), whose
  //      remove('compact') was likewise unconditional.
  {
    const w = world({ width: 390, height: 800, controlBox: { left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800 } });
    const fb = loadFeedback(w);
    w.box._rect = { left: 8, top: 760, right: 382, bottom: 800, width: 374, height: 40 };
    raise(fb, 'pinned first'); w.frame(); w.frame();
    check('setup (B1): a toast with nowhere free pinned, leaving class="top" on the region', w.region.classList.contains('top'),
      `top=${w.region.classList.contains('top')}`);
    // Now a toast that lands at a PLACED spot. The phone's top-edge attempt (area.top+8) needs a free row, so shrink
    // the covering control to leave the top clear: with the region still carrying 'top', placedAt must clear it.
    Object.assign(w.controls[0], { top: 300, bottom: 800, height: 500 });
    fb.clear(); w.frame();
    raise(fb, 'placed after pinned'); w.frame(); w.frame();
    check('setup (B1): the second toast is placed, not pinned', !w.region.classList.contains('top') && w.region.style.left !== '',
      `top=${w.region.classList.contains('top')} left=${JSON.stringify(w.region.style.left)}`);
    const clsBase = w.classWrites('toastRegion').length;
    for (let i = 0; i < 60; i++) w.frame();
    check('a placed toast after a pinned one queues no region class mutation in 60 frames', w.classWrites('toastRegion').length === clsBase,
      `${w.classWrites('toastRegion').length - clsBase} class writes in 60 frames (an unconditional remove('top') gives 60)`);
  }
  {
    // a natural toast after an ERROR toast: #toast keeps class="error", and the natural branch's reapply cleared
    // 'compact' unconditionally
    const w = world();
    const fb = loadFeedback(w);
    fb.toast('something failed', { error: true });
    w.frame(); w.frame();
    check('setup (B2): the error toast left class="error" on the toast', w.box.classList.contains('error'),
      `error=${w.box.classList.contains('error')}`);
    w.box._rect = { left: 248, top: 300, right: 873, bottom: 340, width: 625, height: 40 };   // a free place: natural
    fb.toast('a natural one');   // (show() clears error, then place decides natural)
    w.frame(); w.frame();
    const I = fb.readPlacementInputs();
    check('setup (B2): the second toast decided the natural branch', (globalThis.__decide(I) || {}).kind === 'natural',
      (globalThis.__decide(I) || {}).kind);
    const clsBase = w.classWrites('toast').length;
    for (let i = 0; i < 60; i++) w.frame();
    check('a natural toast queues no class mutation on #toast in 60 frames', w.classWrites('toast').length === clsBase,
      `${w.classWrites('toast').length - clsBase} class writes in 60 frames (an unconditional remove('compact') gives 60)`);
  }

  // ---- the natural branch records its key AFTER it clears #toast.compact ----
  // The natural branch is only reached with the compact form ON after a band placement needed it. `show()` clears the
  // class when a toast is born, so a fresh natural toast never has it; the reachable path is a band placement that
  // chose compact (a narrow band), followed by a geometry change that makes the stylesheet's own place the answer while
  // the class is still on. Recording the key at the wrong moment (before the class is cleared) leaves `compact` in it
  // while the next frame's probe has it off, so that frame re-decides; that is a ONE-FRAME delay, not a loop (measured:
  // the mutant costs exactly one extra decide() at the transition and then caches -- it is a harmless variant, not a
  // defect). What the check below DOES catch is the branch never caching at all: a mutant that stores a key which can
  // never match re-decides every frame, and one frame's class state must not be able to keep that up. `place()` calls
  // the vm context's own `decide` binding, so wrapping it here counts the placement loop's calls and not the suite's.
  {
    // The band must fit only the COMPACT form: its height (34 px) is under the toast's natural height (40) but over the
    // compact one (24). `band.bottom - band.top = 34` here: the tube ends at 570, the screen's text ends at 530, so the
    // band is [532, 566]. A control across the TOP of the window covers the toast's natural place (at 60) AND the fixed
    // top edge, and the screen covers the bottom scan's row, so no free place exists and the band is the answer.
    const ctlTop = { left: 0, top: 0, right: 1440, bottom: 120, width: 1440, height: 120 };
    const w = world({ width: 1440, height: 900, controlBox: [ctlTop] });
    w.screen._rect = { left: 100, top: 200, right: 400, bottom: 860, width: 300, height: 660 };
    w.tube._rect = { left: 100, top: 200, right: 400, bottom: 570, width: 300, height: 370 };
    w.screen.dataset.active = '0,0.1,1,0.5';
    w.box._rect = { left: 248, top: 60, right: 873, bottom: 100, width: 625, height: 40 };   // in view, under ctlTop
    const fb = loadFeedback(w);
    raise(fb, 'band compact'); w.frame(); w.frame();
    check('setup (band-to-natural): the toast took the COMPACT form (the band needed it)', w.box.classList.contains('compact'),
      `compact=${w.box.classList.contains('compact')} left=${JSON.stringify(w.region.style.left)} top=${JSON.stringify(w.region.style.top)}`);
    // now the control goes away: the toast's natural place (248, 60) is free and in view, so the answer becomes 'natural'
    // -- with the compact class still on, which the natural branch clears before it records its key
    Object.assign(ctlTop, { top: 900, bottom: 900, height: 0, width: 0, left: 0, right: 0 });
    w.frame(); w.frame();
    const I = fb.readPlacementInputs();
    check('setup (band-to-natural): the decision is now the stylesheet\'s own place', JSON.parse(JSON.stringify(globalThis.__decide(I))).kind === 'natural',
      JSON.parse(JSON.stringify(globalThis.__decide(I))).kind);
    // wrap the module's decide() for the measured frames only: place() calls the vm context's own `decide` binding
    const ctx = globalThis.__ctx, real = ctx.decide;
    let calls = 0;
    ctx.decide = (arg) => { calls++; return real(arg); };
    for (let i = 0; i < 30; i++) w.frame();
    ctx.decide = real;
    check('a toast that became natural is not re-decided every frame: 0 decide() calls in 30 settled frames', calls === 0,
      `${calls} decide() calls in 30 frames (each one is a full placement decision)`);
  }

  // ---- and it still FOLLOWS a change: a control moving under it moves it ----
  {
    // The toast is position: fixed, so its own rect follows the inline style, not the flow: moving `_rect` under a
    // placed toast is not a layout change it can see (that is what the faithful stand-in made obvious -- see the note
    // in world()). A real layout change is a CONTROL moving or growing under it, which is what the browser check does
    // and what the decision reads. A small control at the left of the bottom band leaves the natural place covered, so
    // the toast is PLACED along the bottom edge clear of it; moving the control to the right frees a nearer spot.
    const ctl = { left: 0, top: 780, right: 400, bottom: 900, width: 400, height: 120 };
    const w = world({ controlBox: ctl });
    const fb = loadFeedback(w);
    w.box._rect = { left: 248, top: 800, right: 873, bottom: 840, width: 625, height: 40 };   // over the control
    raise(fb, 'moving'); w.frame(); w.frame();
    // the position the toast is actually DRAWN at: its rect (which follows the inline style when placed, else _rect)
    const at = () => { const r = w.box.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; };
    const before = at();
    // the control moves to the right half, so the toast's natural spot is free again: it must go back there
    Object.assign(ctl, { left: 1000, right: 1440, width: 440 });
    w.frame(); w.frame();
    const after = at();
    check('a control moving under a placed toast moves it (the chain is still placing it)',
      (before.left !== after.left || before.top !== after.top)
        && after.top >= 0 && after.top + 40 <= 900,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  // ---- the style is CLEARED when the stylesheet's own place is right (the stale-inline pitfall) ----
  {
    // a small control at the left of the bottom band covers a toast's natural place, so the toast is PLACED clear of
    // it (not pinned: a pinned toast is deliberately kept in the top slot and never re-placed). When the control goes
    // away the natural place is free again, and place() must clear the inline left/top it set -- a stale inline style
    // would keep it at the old spot.
    const ctl = { left: 0, top: 780, right: 400, bottom: 900, width: 400, height: 120 };
    const w = world({ controlBox: ctl });
    const fb = loadFeedback(w);
    w.box._rect = { left: 248, top: 800, right: 873, bottom: 840, width: 625, height: 40 };
    raise(fb, 'settle'); w.frame(); w.frame();
    const placed = w.region.style.left !== '' && !w.region.classList.contains('top');
    // the control is gone (zero size is filtered out of the inputs): the stylesheet's own place is free
    Object.assign(ctl, { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
    w.frame(); w.frame();
    check('when the stylesheet place is right again, the inline style it replaced is cleared',
      placed && w.region.style.left === '' && w.region.style.top === '', `placed=${placed} left=${JSON.stringify(w.region.style.left)} top=${JSON.stringify(w.region.style.top)}`);
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

  // ---- the decision is PURE in EVERY arm, and every input it uses reaches it ----
  // decide() is exported and takes only its inputs. Two complementary guards, run over ARM_INPUTS so both execute each
  // branch of decide(): the DOM made hostile (document/window throw on ANY property access -- catches a read of
  // `document.body`), and an isolated vm context with NOTHING but the inputs (catches a bare `innerWidth`,
  // `location.hash`, `safeArea()` or `Date.now()` that the first guard cannot see). Running them on one arm only left a
  // global read in the ordinary natural/placed path (`if (at)`) green; the checks below assert each arm is
  // reached, so a guard that stops covering a branch fails instead of passing vacuously.
  {
    isolatedDecide = buildIsolatedDecide();
    for (const [arm, I] of Object.entries(ARM_INPUTS)) {
      check(`setup (arm ${arm}): ARM_INPUTS reaches the ${arm} branch`,
        (globalThis.__decide(I) || {}).kind === arm, JSON.stringify((globalThis.__decide(I) || {}).kind));
      const hostile = decideWithHostileDom({ ...I });
      check(`decide() reads no DOM on the ${arm} arm (document/window throw if touched)`,
        !!hostile && hostile.kind === arm, JSON.stringify(hostile).slice(0, 80));
      const iso = isolated({ ...I });
      check(`decide() needs no global but its inputs on the ${arm} arm (isolated context: no innerWidth, location, Date, module state)`,
        iso.ok && (iso.value || {}).kind === arm, iso.ok ? JSON.stringify(iso.value).slice(0, 70) : iso.error);
      check(`... and the isolated ${arm} decision agrees with the module's own decide()`,
        iso.ok && JSON.stringify(iso.value) === JSON.stringify(decide({ ...I })), iso.ok ? 'agrees' : iso.error);
    }
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
    // The band form must avoid the SCREEN'S VISIBLE TEXT, not only the controls: a toast on the screen's border under
    // the text must never sit on the text itself. BASE leaves the band as the only free place and its text area is a
    // strip inside the screen; widening that strip so the band cannot clear it must change the answer (the band is
    // refused and the toast goes to the top slot). A decision that built its avoid-list from `controls` alone ignores
    // the text entirely and gives the same band answer either way.
    // The band answer carries the list of rects its placement must clear (`offText`), and that list is built from the
    // controls AND the screen's visible text. Testing the list itself is what this property is: a decision that built it
    // from the controls alone is the mutant this catches, and whether a particular geometry also happens to move the
    // band is not something a single case can guarantee.
    const bandOff = JSON.parse(verdict({}));
    check('the band form\'s avoid-list carries the screen\'s visible text, not only the controls',
      bandOff.kind === 'band' && Array.isArray(bandOff.offText) && bandOff.offText.length === 2 &&
        bandOff.offText.some((o) => o.left === 100 && o.top === 266 && o.right === 800 && o.bottom === 530),
      JSON.stringify(bandOff.offText));
    // EDGE TOUCHING is clear, not a hit. A control whose bottom edge is exactly the toast's top edge does not overlap
    // it, so a toast there is at its natural place; `hits` compares with `<=`/`>=` for that reason. With `<`/`>`, a
    // flush edge reads as an overlap and the toast is moved off a place that is in fact free.
    //   the toast: y 40..80. The control: y 0..40 (its bottom is the toast's top -- flush, not overlapping).
    const flush = { ...BASE, screen: [], tube: null, canvas: null, active: '',
      box: { left: 40, top: 40, right: 665, bottom: 80, width: 625, height: 40 },
      controls: [{ left: 0, top: 0, right: 1440, bottom: 40, width: 1440, height: 40 }] };
    // All FOUR edges, because `hits` compares both axes independently: a `<` slipped into any one comparison is only
    // caught by the edge that exercises it.
    //   the toast sits at (40,40)-(665,80) and the control is flush against one of its sides, in view and alone.
    const edges = {
      top:    { left: 0, top: 0, right: 1440, bottom: 40, width: 1440, height: 40 },          // control's bottom == toast's top
      bottom: { left: 0, top: 80, right: 1440, bottom: 120, width: 1440, height: 40 },        // control's top == toast's bottom
      left:   { left: 0, top: 0, right: 40, bottom: 900, width: 40, height: 900 },           // control's right == toast's left
      right:  { left: 665, top: 0, right: 705, bottom: 900, width: 40, height: 900 },         // control's left == toast's right
    };
    // one pixel of overlap on each side, to prove the same edge is a hit when it really overlaps
    const overlap = {
      top: { ...edges.top, bottom: 41 },
      bottom: { ...edges.bottom, top: 79 },
      left: { ...edges.left, right: 41 },
      right: { ...edges.right, left: 664 },
    };
    const base = { ...BASE, screen: [], tube: null, canvas: null, active: '',
      box: { left: 40, top: 40, right: 665, bottom: 80, width: 625, height: 40 } };
    for (const side of ['top', 'bottom', 'left', 'right']) {
      check(`a toast flush against a control's ${side} edge counts as clear (touching is not overlapping)`,
        JSON.stringify(decide({ ...base, controls: [edges[side]] })) === JSON.stringify({ kind: 'natural' }),
        JSON.stringify(decide({ ...base, controls: [edges[side]] })).slice(0, 60));
      check(`... and one pixel of overlap on the ${side} IS a hit (the toast is moved)`,
        JSON.stringify(decide({ ...base, controls: [overlap[side]] })) !== JSON.stringify({ kind: 'natural' }),
        JSON.stringify(decide({ ...base, controls: [overlap[side]] })).slice(0, 60));
    }
    // the box's own place: with no controls, a box already at a free spot takes the natural answer
    check('the decision uses the box position',
      verdict({ controls: [], box: { ...BASE.box, left: 40, top: 40, right: 665, bottom: 80 } }) !== verdict({ controls: [] }),
      verdict({ controls: [], box: { ...BASE.box, left: 40, top: 40, right: 665, bottom: 80 } }).slice(0, 40));
    // the phone flag drops the row of x-attempts
    check('the decision uses the phone flag', verdict({ phone: true, controls: [] }) !== verdict({ controls: [] }),
      verdict({ phone: true, controls: [] }).slice(0, 40));
    // determinism: two separate calls on equal (not identical) inputs agree, which is what lets one stringified copy be
    // the cache key. Written against the literal expected verdict so it cannot pass by comparing a call to itself.
    check('... and equal inputs give the one expected verdict (so one stringified copy is a sound cache key)',
      verdict({}) === JSON.stringify({ kind: 'band', band: { left: 108, right: 792, top: 532, bottom: 696 },
        // the control the toast must avoid, and the screen's visible text area (data-active 0,0.1,1,0.5 of MON)
        offText: [{ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 },
          { left: 100, top: 266, right: 800, bottom: 530 }], fullWidth: 625 }),
      verdict({}).slice(0, 60));
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

  // ---- a toast with nowhere free takes the fixed top slot, and STAYS there for nothing ----
  // On a phone with the whole viewport covered by a control, no place is free, so place() takes the fixed top slot and
  // PINS the toast: `place` returns at its first line every later frame, so the slot is kept by the pin, not by re-placing
  // each frame. This is the path the browser check exercises on a phone (never invisible beats no control covered).
  // It is checked explicitly because it is otherwise UNREACHED: a mutant that drops the pinned early-return leaves every
  // other check green, and on main a pinned toast re-placed (and rewrote the region) every frame.
  {
    // the control covers the whole window, so the natural place, the bottom scan and the band are all covered
    const w = world({ width: 390, height: 800, controlBox: { left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800 } });
    const fb = loadFeedback(w);
    w.box._rect = { left: 8, top: 760, right: 382, bottom: 800, width: 374, height: 40 };
    raise(fb, 'nowhere'); w.frame(); w.frame();
    check('setup (everywhere covered): the toast took the fixed top slot', w.region.classList.contains('top'), `top-class=${w.region.classList.contains('top')} left=${JSON.stringify(w.region.style.left)}`);
    // once pinned, later frames must not touch the region at all -- the early return, not a matching key, is what keeps it
    const before = w.writes('toastRegion').length;
    for (let i = 0; i < 30; i++) w.frame();
    check('a pinned toast costs no region writes: 30 frames after it pinned write nothing', w.writes('toastRegion').length === before,
      `${w.writes('toastRegion').length - before} writes in 30 frames (main: re-placed every frame)`);
    // and it really is pinned (the region keeps the class and its inline top across those frames)
    check('... and it is still in the top slot afterwards', w.region.classList.contains('top') && w.region.style.top !== '',
      `top=${JSON.stringify(w.region.style.top)} class=${w.region.classList.contains('top')}`);
  }

  // ---- the safe area changes under a pinned toast (a notched phone rotating) ----
  // --safe-t is env(safe-area-inset-top): a notch at the top in portrait, at the side in landscape, so rotating changes
  // it. The pin kept the slot top it first computed, which left the toast under the notch. The slot must be re-applied
  // from the new insets, and only then (an unchanged area costs nothing).
  {
    const w = world({ width: 390, height: 800, controlBox: { left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800 } });
    const fb = loadFeedback(w);
    w.box._rect = { left: 8, top: 760, right: 382, bottom: 800, width: 374, height: 40 };
    raise(fb, 'notched'); w.frame(); w.frame();
    check('setup (C): the toast pinned with no top inset', w.region.classList.contains('top') && w.region.style.top === '8px',
      `top=${JSON.stringify(w.region.style.top)}`);
    // rotate to a notch at the top: --safe-t becomes 44 px
    w.sandbox.__safeTop = 44;
    w.frame(); w.frame();
    check('a safe-area change under a pinned toast moves its slot (clear of the notch)',
      w.region.style.top === `${Math.round(44 + 8)}px`, `top=${JSON.stringify(w.region.style.top)} (want 52px)`);
    check('... and it is still pinned in the top slot', w.region.classList.contains('top'));
    // an unchanged area afterwards costs nothing
    const before = w.writes('toastRegion').length;
    for (let i = 0; i < 20; i++) w.frame();
    check('... and an unchanged safe area costs no writes in 20 further frames', w.writes('toastRegion').length === before,
      `${w.writes('toastRegion').length - before} writes in 20 frames`);
  }

  // ---- the phone flag alone moves a pinned toast's slot (the offset is 8 px on a phone, 16 px otherwise) ----
  // A pinned toast keeps its slot until it goes, and re-applies it only when the inputs that place it change. The safe
  // area is one; the phone flag is the other, because it picks the 8/16 px offset. A window crossing 700 px with the
  // safe area unchanged left the old offset in place (an 8 px slot on a desktop-width window).
  {
    const w = world({ width: 390, height: 844, controlBox: { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 } });
    // the safe area held FIXED, so the only input that changes when the window widens is the phone flag
    w.sandbox.__safeFixed = { left: 0, top: 0, right: 844, bottom: 844 };
    const fb = loadFeedback(w);
    w.box._rect = { left: 8, top: 760, right: 382, bottom: 800, width: 374, height: 40 };
    raise(fb, 'phone flag'); w.frame(); w.frame();
    check('setup (phone flag): pinned on a 390 px window at the phone offset', w.region.style.top === '8px',
      `top=${JSON.stringify(w.region.style.top)}`);
    // widen past 700 px with the SAFE AREA UNCHANGED (0 insets all round): only the phone flag changes
    w.sandbox.innerWidth = 900; w.sandbox.innerHeight = 844;
    w.frame(); w.frame();
    check('crossing 700 px re-applies a pinned toast\'s slot at the non-phone offset (16 px)',
      w.region.style.top === '16px', `top=${JSON.stringify(w.region.style.top)} (want 16px)`);
    // and back again
    w.sandbox.innerWidth = 390;
    w.frame(); w.frame();
    check('... and crossing back re-applies it at the phone offset (8 px)', w.region.style.top === '8px',
      `top=${JSON.stringify(w.region.style.top)} (want 8px)`);
  }

  // ---- the BAND branch: the toast fits on the screen's border under its text, compact if need be, and caches ----
  // No free place exists (the controls leave only a thin strip the toast is too tall for), but the strip under the
  // screen's visible text has room. place() measures two forms (full width, then compact) and writes the one that fits
  // into `decided`, recording the key AFTER the put. This scenario exists because the band branch is otherwise NEVER
  // reached in Node: without it, a mutant that recorded the band key before its put -- the bug the band path did not have
  // but the placed path did -- passed, because nothing placed a toast in the band.
  {
    const w = world({ width: 1440, height: 900, controlBox: [
      { left: 0, top: 0, right: 1440, bottom: 698, width: 1440, height: 698 },      // the whole upper window
      { left: 0, top: 762, right: 1440, bottom: 900, width: 1440, height: 138 },    // and the bottom band
    ] });
    w.screen._rect = { left: 100, top: 200, right: 800, bottom: 860, width: 700, height: 660 };
    w.tube._rect = { left: 100, top: 200, right: 800, bottom: 760, width: 700, height: 560 };
    w.screen.dataset.active = '0,0.1,1,0.5';
    // the toast's own rect, as the unplaced stylesheet places it, is large: it does not fit the strip full width
    w.box._rect = { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 };
    const fb = loadFeedback(w);
    raise(fb, 'band'); w.frame(); w.frame();
    const I = fb.readPlacementInputs();
    check('setup (band): the decision is the band branch', JSON.parse(JSON.stringify(globalThis.__decide(I))).kind === 'band',
      JSON.parse(JSON.stringify(globalThis.__decide(I))).kind);
    check('the band branch placed the toast', w.region.style.left !== '' && !w.region.classList.contains('top'),
      `left=${JSON.stringify(w.region.style.left)} top=${JSON.stringify(w.region.style.top)} topclass=${w.region.classList.contains('top')}`);
    // and it caches: with the geometry unchanged, later frames write nothing (a band key recorded before its put, at the
    // pre-put width, differed every frame and re-measured)
    const before = w.writes('toastRegion').length;
    for (let i = 0; i < 20; i++) w.frame();
    check('the band placement does not oscillate: no writes in 20 settled frames', w.writes('toastRegion').length === before,
      `${w.writes('toastRegion').length - before} writes in 20 frames`);
  }

  // ---- EVERY INPUT decide() READS IS IN THE CACHE KEY ----
  // The placement is cached under JSON.stringify(readInputs()), and a frame whose key matches is re-applied without
  // deciding. That is only sound if the key carries every input the decision reads: an input that decides but is not in
  // the key means a frame that should have decided re-applies a stale answer.
  // Each case changes ONE input through the real DOM stand-in, then runs TWO frames with nothing else changed. The
  // first frame after the change must DECIDE (the key differs, so place() finds no match) and the second must RE-APPLY
  // (the key recorded by the first now matches). Both halves matter, and for opposite reasons: a miss alone is true for
  // a key that never matches at all -- which is exactly what dropping an input from the recorded key produces -- and a
  // hit alone is true for a key that ignores the changed input.
  {
    // a settled, positioned toast whose placement these inputs can each move or refine
    const setup = () => {
      const w = world({ width: 1440, height: 900, controlBox: null });
      w.screen._rect = { left: 100, top: 200, right: 800, bottom: 860, width: 700, height: 660 };
      w.tube._rect = { left: 100, top: 200, right: 800, bottom: 700, width: 700, height: 500 };
      w.screen.dataset.active = '0,0.1,1,0.5';
      w.box._rect = { left: 248, top: 940, right: 873, bottom: 980, width: 625, height: 40 };
      const fb = loadFeedback(w);
      raise(fb, 'cache key'); w.frame(); w.frame();
      return { w, fb };
    };
    const placement = (w) => ({ left: w.region.style.left, top: w.region.style.top, width: w.region.style.width, top_class: w.region.classList.contains('top') });
    // Whether place() RE-DECIDED this frame: feedback.js exposes no cache state, so this is read the way the page pays
    // for it -- `decide()` runs, which the suite's own wrapper can count. `place()` calls the module's `decide`, which
    // is the vm context's binding, so wrapping it counts the placement loop's calls only.
    const calls = () => { const ctx = globalThis.__ctx, real = ctx.decide; let n = 0;
      ctx.decide = (a) => { n++; return real(a); }; return { stop: () => { ctx.decide = real; }, count: () => n }; };
    // Each case makes ONE input change, then requires the next frame to DECIDE and the one after to RE-APPLY.
    // The mutation these guard against is the one the page can actually suffer: a field dropped from BOTH keys -- from
    // `probe` (which the compare stringifies) and from the object `settle()` records. Dropping it from only one leaves
    // the two keys permanently unequal, which fails everything and proves nothing about that field.
    //
    // Measured with that both-keys drop, over readInputs()'s eleven fields:
    //   CAUGHT BY NAME (5): area, active, screen, box, classes. (classes decides nothing itself -- decide() does not read
    //     it -- but it is in the key, so a class change that should re-place a toast does; dropping it loses that.)
    //   CAUGHT BY NAME PLUS ITS NEIGHBOURS (1): controls, whose change also moves what the other cases measure.
    //   SURVIVE THE DROP (3), and correctly: phone, tube and canvas -- each one an input decide() really reads, whose
    //     value the key also carries elsewhere (phone is area's own width test; tube and canvas are rects inside screen),
    //     so dropping it alone changes nothing the placement can see.
    //   SURVIVE THE DROP HERE (2), and are caught by the browser check instead: sideKeys and barBottom. Unlike the three
    //     above, each is an input the placement really reads whose value NO other field carries (sideKeys is a body class
    //     and a media query: with it a sideways touch phone's toast takes the band under the picture, without it the
    //     toast falls to the fixed top slot; barBottom is the app bar's bottom edge: without it the top slot stops
    //     standing under the bar), so their loss does change what the page does. This suite has no case that sets either:
    //     its sandbox has no touch-keys body class with a landscape window and no app bar, so it cannot see the drop.
    // The test does not claim the five: the three are carried in the key by construction (one object, one stringify) but
    // their loss is invisible to the placement because another field already carries the same value; the two are claimed
    // where the page has what they read: `feedbackModel`'s sideways-phone check (sideKeys: the toast under the picture,
    // not in the top slot) and `mobile`'s "lies under the app bar" check (barBottom), each measured red against the drop.
    // (readInputs also carried winW, winH and view. Nothing read any of them -- not decide(), not the band writer, not the
    // pinned slot, not anything else -- so their only effect was a re-decide whose answer was identical, and they are
    // gone. How each was covered, precisely -- not the same way for the three:
    //   winH, winW  only APPROXIMATELY: `area` is the window's size minus its insets, so `area` carries the size only
    //               through that subtraction;
    //   view        not by `area` at all: it was constant while a toast is placed, because place() returns before
    //               deciding when the page is not the emulator, so it never varied.
    // And the window's width is still read directly elsewhere: `phone` is `innerWidth <= 700` on the line below.)
    // NOTE: none of the first nine of these mutants is caught by `--only feedback`, measured by running that group against
    // one of them (it passed 46/46); only this suite drives the placement model the key belongs to. The last two, sideKeys
    // and barBottom, are not caught by this suite either, but by the `feedbackModel` and `mobile` browser groups above.
    const cases = [
      ['area.top (the safe-area inset)', ({ w }) => { w.sandbox.__safeTop = 30; }],
      ['active (the screen\'s visible text)', ({ w }) => { w.screen.dataset.active = '0,0.4,1,0.9'; }],
      ['tube (the monitor\'s tube)', ({ w }) => { w.tube._rect = { left: 100, top: 200, right: 800, bottom: 860, width: 700, height: 660 }; }],
      ['canvas (the screen element)', ({ w }) => { w.screen._rect = { left: 60, top: 160, right: 840, bottom: 900, width: 780, height: 740 }; }],
      ['screen (the monitor\'s own box)', ({ w }) => { w.monitor._rect = { left: 80, top: 180, right: 820, bottom: 880, width: 740, height: 700 }; }],
      ['controls (the elements avoided)', ({ w }) => { Object.assign(w.controls[0], { top: 700, height: 200, bottom: 900 }); }],
      // the toast's own rect: with the toast PLACED, its measured rect follows the region's inline style, so changing
      // `_rect` alone would not reach decide(). Change the width it is placed at instead, which does.
      ['box (the toast\'s own rect)', ({ w }) => { w.region.style.width = '400px'; }],
      ['phone (the window width across the 700 px threshold)', ({ w }) => { w.sandbox.innerWidth = 690; }],
      ['classes (the toast\'s or the page\'s class list)', ({ w }) => { w.box.classList.add('error'); }],
    ];
    for (const [name, change] of cases) {
      const ctx = setup();
      const before = placement(ctx.w);
      change(ctx);
      // frame 1 after the change: the key differs, so place() DECIDES (a miss)
      const c1 = calls(); ctx.w.frame(); c1.stop();
      const after = placement(ctx.w);
      // frame 2 with nothing further changed: the key recorded on frame 1 must match, so place() RE-APPLIES (a hit).
      // Both halves are needed. A miss alone is true for a key that NEVER matches, which is what dropping an input
      // from the key produces -- and that is the mutant this check exists to catch. A hit alone is true for a key that
      // ignores the changed input, which is the other direction. Together: the key tracks exactly these inputs.
      const c2 = calls(); ctx.w.frame(); c2.stop();
      check(`the cache key carries ${name}: changing it re-decides, and the frame after that re-applies`,
        c1.count() > 0 && c2.count() === 0,
        `after the change: ${c1.count()} decide() call(s); next frame: ${c2.count()}; before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    }
  }

  console.log(fail ? `${fail} of ${n} toast-follow checks FAILED` : `${n}/${n} toast-follow checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
