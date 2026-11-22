// Run: node tests/view-order.test.js
//
// The full-screen chat's close is registered by js/ui/claude.js ITSELF with
// `{ every: true, beforeView: true }`, and that option is load-bearing. This drives the REAL setupClaude and the
// real page route over a small DOM stub, so deleting the option in claude.js turns this red - which the stand-in
// handlers in tests/view-order.test.js cannot do, because they never load claude.js.
//
// What the option buys, exactly: with `beforeView: true` the close goes into the page's `firstFns`, which run on
// EVERY route BEFORE the view handlers. Without it (keeping `every: true`) it goes into `stepFns`, which also run on
// every route - but AFTER the view handlers. So the observable difference is the order on a route that opens a
// view: the Debugger's refresh (session.debug) must find the BASIC session already back, not build a debugger on the
// chat machine and have it detached a moment later.
const path = require('path');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

// ---- a DOM good enough for createPage + setupClaude: only what their module scope and the route touch ----
const mk = (id = '') => {
  const classes = new Set();
  return { id, hidden: false,
    classList: { contains: (c) => classes.has(c), toggle(c, on) { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; }, add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    focus() {}, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }), append() {}, appendChild() {},
    replaceChildren() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, textContent: '',
    innerHTML: '', value: '', checked: false, firstChild: null, removeAttribute() {}, insertBefore() {}, cloneNode: () => mk(id),
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    width: 320, height: 240 };
};
const els = new Map();
const bodyEl = mk('body');
globalThis.document = { getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  body: bodyEl, documentElement: mk(), createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0' });
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.location = { hash: '', href: 'http://localhost/play/', pathname: '/play/', search: '' };
// the hash follows the URL, as the browser's does: route() reads location.hash to decide whether a view is shown
const setUrl = (u) => { globalThis.location.hash = u && u.includes('#') ? '#' + u.split('#')[1] : ''; };
globalThis.history = {
  state: null,
  pushState(s, t, u) { this.state = s; if (u) setUrl(u); },
  replaceState(s, t, u) { this.state = s; if (u) setUrl(u); },
  back() {},
};
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.scrollTo = () => {};
globalThis.window = globalThis;

(async () => {
  const { createPage } = await import(path.join(__dirname, '../js/ui/page.js'));
  const { setupClaude } = await import(path.join(__dirname, '../js/ui/claude.js'));

  // a Session-ish object for setupClaude's scope; none of these is reached by the route under test
  const closed = { toSidePanel: 0, endChat: 0 };
  const session = {
    claudeView: 'panel', chat: null, chatMachines: null, claudeBusyActing: false, claudePending: null,
    keyStore: { get: () => null, set() {} }, store: { get: () => null, set() {} }, display: {},
    on() { return () => {}; }, emit() {}, personMachine: { profile: {}, config: {} },
    toSidePanel() { closed.toSidePanel++; this.claudeView = 'panel'; }, endChat() { closed.endChat++; this.chat = null; },
    nitros9On: () => false, besideMachine: () => null,
  };
  const page = createPage(session, { running: false, start() {} });
  // page.js builds its own session-shaped view of the object it is handed; setupClaude reads page.session, so point
  // the page's session at the real object's members (createPage copies it into the page record)
  setupClaude(page);

  // Stand in a view handler AFTER setupClaude, the way a view (the Debugger) registers its refresh. When it runs, it
  // records whether the chat was still open. With `beforeView: true` the chat's close has already run; without it,
  // this handler runs first and sees the chat open.
  let seenOpenAtView = null;
  page.onView(() => { seenOpenAtView = document.body.classList.contains('claude-open'); });
  // and a step handler, to prove the order the option controls (a step runs after the view handlers either way)
  let seenOpenAtStep = null;
  page.onView(() => { seenOpenAtStep = document.body.classList.contains('claude-open'); }, { every: true });

  // put the page in the full-screen chat's state: the body class is what claude.js's own close checks, and the
  // session says its chat view is full (so close() takes the toSidePanel branch)
  bodyEl.classList.add('claude-open');
  session.claudeView = 'full';
  check('fixture: the chat is open before the route', document.body.classList.contains('claude-open') && session.claudeView === 'full');

  page.openView('#debugger');

  check('the real claude.js closes the chat BEFORE the view handlers build on the machine (beforeView: true)',
    seenOpenAtView === false, `the view handler saw the chat ${seenOpenAtView === null ? 'never ran' : seenOpenAtView ? 'OPEN' : 'closed'}`);
  check('and the close really happened through Session.toSidePanel (the chat view came back to the panel)', closed.toSidePanel === 1 && session.claudeView === 'panel',
    JSON.stringify({ ...closed, view: session.claudeView }));
  check('the step handler still runs, after the view handler and with the chat closed', seenOpenAtStep === false, String(seenOpenAtStep));
  check('the view opened (the entry is the view\'s)', history.state && history.state.view === '#debugger');

  console.log(fail ? `\n${fail} FAILED` : '\nall claude beforeView checks passed');
  process.exitCode = fail ? 1 : 0;
})();
