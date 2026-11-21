// Run: node tests/view-order.test.js
//
// The page's route, driven in Node with a small DOM stub: which handlers run, and in what order, when a view opens
// over the full-screen chat. The property is one the Debugger found (PM 124): a view's handler (the Debugger's
// refresh -> session.debug) must not run while the chat is still open, because the chat is closed in the same step
// and a debugger built on the chat machine would be detached a moment later - built to be thrown away. So the
// chat's close runs BEFORE the view handlers (page.onView's beforeView), and this pins it: a route that ran the view
// handlers first is red here.
const path = require('path');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- a DOM good enough for createPage: only what the module's scope and route() touch ----
const mk = (id = '') => ({ id, hidden: false, classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
  focus() {}, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }), append() {}, appendChild() {},
  replaceChildren() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
  style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, textContent: '',
  innerHTML: '', value: '', checked: false, firstChild: null, removeAttribute() {}, insertBefore() {}, cloneNode: () => mk(id) });
const els = new Map();
const setUrl = (u) => { globalThis.location.hash = u && u.includes('#') ? '#' + u.split('#')[1] : ''; };
globalThis.document = { getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  body: mk(), documentElement: mk(), createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0' });
globalThis.location = { hash: '', href: 'http://localhost/play/', pathname: '/play/', search: '' };
globalThis.history = { state: null, pushState(s, t, u) { this.state = s; setUrl(u); }, replaceState(s, t, u) { this.state = s; setUrl(u); }, back() {} };
globalThis.addEventListener = () => {};

(async () => {
  const { createPage } = await import(path.join(__dirname, '../js/ui/page.js'));
  const order = [];
  const page = createPage({ machine: null, on() {}, emit() {}, store: { get: () => null, set() {} }, display: {} }, { running: false, start() {} });
  page.onView(() => order.push('view'));                                       // stands in for the Debugger's refresh
  page.onView(() => order.push('chat-close'), { every: true, beforeView: true });   // the chat's own close
  page.openView('#debugger');
  check('a view opened over the chat: the chat closes before the view handler builds on the machine',
    JSON.stringify(order) === '["chat-close","view"]', JSON.stringify(order));
  // and a comment/detail check that the crash class it prevents is still the one named (a view handler that ran on
  // the chat machine would have seen chatMachines set; the order above is what makes that impossible)
  check('the route reached the view (the entry is the view\'s)', history.state && history.state.view === '#debugger');

  // a panel's handler registered WITHOUT beforeView runs after the view handlers, as before (nothing else moved)
  const order2 = [];
  const page2 = createPage({ machine: null, on() {}, emit() {}, store: { get: () => null, set() {} }, display: {} }, { running: false, start() {} });
  page2.onView(() => order2.push('view'));
  page2.onView(() => order2.push('step'), { every: true });
  page2.openView('#share');
  check('an every-step handler that is not beforeView still runs after the view handlers',
    JSON.stringify(order2) === '["view","step"]', JSON.stringify(order2));

  console.log(fail ? `\n${fail} FAILED` : `\nall ${n} view-order checks passed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.log('FAIL view-order crashed:', e.message); process.exitCode = 1; });
