// Run: node tests/chat-leaks-scan.test.js
//
// The raw-machine scan (tests/chat-leaks.test.js) must SEE the shapes its own boundary comment lists as misses.
// That comment is honest, but a documented hole is still a hole: a `this?._shown` or a `const sess = page.session;
// sess.machine` written tomorrow would pass the scan and act on the wrong machine.
//
// Each row plants ONE shape in a real file of a throwaway copy and runs the scan. CAUGHT = the scan names it AT THE
// PLANTED LINE; MISSED = the suite is still green. The two known-caught controls show the harness works.
//
// IN PROCESS: the scan over a root is a function of that root (`rawMachineUses(root)`), so this suite requires the
// scan and calls it; it does not spawn `node tests/chat-leaks.test.js --scan-only`. One spawn per row cost 0.9 s x 31
// and took this suite to 95 s in CI, past the gate's budget.
//
// The shapes are the ones listed under THE BOUNDARY in tests/chat-leaks.test.js, CAUGHT and NO LONGER FLAGGED alike;
// the NOT CAUGHT list there has no row here, on purpose (a row would claim what the reader cannot do).
//
// FAST: the scan keeps each file's result by its text (tests/chat-leaks.test.js, scanFile), so a row re-reads only the
// file it planted; the whole suite is one copy of the tree plus one read per row.
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-scan-probe-'));
const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exitCode = 130; });

// the plant goes immediately after `find`, which must occur exactly once in the file
const CASES = [
  { id: 'control: this._shown (already caught)', file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: '    if (this._shown) this._shown.z = 1;\n' },
  { id: 'control: page.session._shown (already caught)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  if (page.session._shown) page.session._shown.z = 1;\n' },
  { id: 'this?._shown', file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: '    if (this?._shown) globalThis.__z = 1;\n' },
  { id: "this['_shown']", file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: "    if (this['_shown']) globalThis.__z = 1;\n" },
  { id: 'const { _shown } = this', file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: '    const { _shown } = this; if (_shown) globalThis.__z = 1;\n' },
  // the alias and the use are on SEPARATE LINES on purpose: on one line a per-line learning would pass this row, so
  // the row would not be testing that learning is per class (see the delta in the STATUS: learning per line turns it red)
  { id: 'const self = this; self._shown (the alias on its own line)', file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: '    const self = this;\n    if (self._shown) globalThis.__z = 1;\n', use: 'if (self._shown)' },
  { id: 'const sess = page.session; sess._shown', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const sess = page.session; if (sess._shown) globalThis.__z = 1;\n' },
  { id: 'const sess = page.session; sess.machine', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const sess = page.session; if (sess.machine) globalThis.__z = 1;\n' },
  { id: 'const k = "_shown"; session[k]', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const k = "_shown"; if (session[k]) globalThis.__z = 1;\n' },
  { id: 'const { _shown: mm } = this.session (embed-api)', file: 'js/embed-api.js',
    find: '    return this.session.typeText(text, this.session.personMachine);\n', insert: '    const { _shown: mm } = this.session; if (mm) globalThis.__z = 1;\n' },
  // the member forms of the machine name itself, and the destructures the boundary comment claims: each is a plant
  // here so the comment's "caught" list is a measurement rather than a claim
  { id: 'session?.machine (the optional-call form)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  if (page.session?.machine) globalThis.__z = 1;\n' },
  { id: "session['machine'] (the bracket form)", file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: "  if (session['machine']) globalThis.__z = 1;\n" },
  { id: 'session[`machine`] (the template-key form)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  if (session[`machine`]) globalThis.__z = 1;\n' },
  { id: 'const a = session, b = a; b.machine (a layered alias)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const a = session, b = a; if (b.machine) globalThis.__z = 1;\n' },
  { id: 'const { session: s2 } = page; s2.machine (a renamed destructure)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const { session: s2 } = page; if (s2.machine) globalThis.__z = 1;\n' },
  { id: 'const { machine } = this.session (embed-api)', file: 'js/embed-api.js',
    find: '    return this.session.typeText(text, this.session.personMachine);\n', insert: '    const { machine } = this.session; if (machine) globalThis.__z = 1;\n' },
  { id: 'const { machine } = session (a bare Session destructure)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const { machine } = session; if (machine) globalThis.__z = 1;\n' },
  { id: 'const s = this.session; s.machine (a member of this)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const s = this.session; if (s.machine) globalThis.__z = 1;\n' },
  { id: 'const a = session, b = 2; a.machine (the comma-only declarator)', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const a = session, b = 2; if (a.machine) globalThis.__z = 1;\n' },
  // `window.emu.machine` is NOT a raw reach and must NOT be caught: js/ui/main.js defines it as a named accessor
  // returning session.shownMachine. Allowing it is a decision, so it is tested from both sides - that it IS allowed
  // (a page-driving tool keeps working) and that the allowance is BOUNDED (an alias or a non-tool file is still caught).
  { id: 'window.emu.machine (allowed: a named shown-machine accessor)', file: 'tools/browser-check-lib.js',
    find: 'const at = () => page.evaluate(() => window.emu.machine.frameCount);\n',
    mutateTo: 'const at = () => page.evaluate(() => { window.emu.machine.x = 1; return window.emu.machine.frameCount; });\n', expect: 'allow' },
  // an ALIAS of the accessor is ALLOWED (documented limit, see THE BOUNDARY): reading the shown machine through one is
  // what ~70 call sites in the page-driving tools do, and refusing it would need every read told from every write. It
  // is a policy, not a limit of the reader. The row records the decision, so a later reader does not "fix" it blind.
  { id: 'const m = window.emu.machine (allowed: an alias read, a known limit)', file: 'tools/capture-images.js',
    find: 'const f = window.emu.machine.render(), src = document.createElement(\'canvas\');\n',
    mutateTo: 'const f = window.emu.machine.render(); const mm = window.emu.machine; const z = mm.render();\n', expect: 'allow' },
  // the allowance is bounded: reaching the SESSION through emu is an ordinary raw use and is caught
  { id: 'window.emu.session.machine (emu is a holder: its session is scanned)', file: 'tools/browser-check-lib.js',
    find: 'const at = () => page.evaluate(() => window.emu.machine.frameCount);\n',
    insert: 'const at2 = () => page.evaluate(() => window.emu.session.machine.frameCount);\n' },
  // and it does not follow the name into a file that is not a page-driving tool: `.machine` must NOT be allowed here,
  // while the same `.machine` IS allowed in a tool. (The `window.` prefix is dropped in this file, so the line is the
  // bare `emu.machine` form the exemption is written for - and the ONLY difference from the allowed rows is the file.)
  { id: 'emu.machine outside the page-driving tools (not exempt)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  page.evaluate(() => emu.machine.id);\n' },
  // ---- the realistic evasions the review named, each closed and each with its own row ----
  { id: 'page.session then .machine on the next line', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  const sess2 = page.session;\n  if (sess2.machine) globalThis.__z = 1;\n', use: '  if (sess2.machine)' },
  { id: "this?.['_shown'] (optional bracket)", file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: "    if (this?.['_shown']) globalThis.__z = 1;\n" },
  { id: "session?.['machine'] (optional bracket)", file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: "  if (session?.['machine']) globalThis.__z = 1;\n" },
  { id: 'let sess; sess = page.session; sess.machine', file: 'js/ui/claude.js', find: '  }, { every: true, beforeView: true });\n',
    insert: '  let sess3; sess3 = page.session; if (sess3.machine) globalThis.__z = 1;\n' },
  { id: 'a destructure spread over three lines', file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: '    const {\n      _shown\n    } = this; if (_shown) globalThis.__z = 1;\n' },
  { id: "const k = '_shown'; this[k] (a computed key in the Session)", file: 'js/session.js', find: '  welcomeSound() {\n',
    insert: "    const k = '_shown'; if (this[k]) globalThis.__z = 1;\n" },
  // ---- round-3 review: the shapes a file-wide, per-line or last-one-wins rule let through ----
  // (3a) a destructure of the MACHINE spread over lines, in a page module (the multi-line rule used to live only in
  // the Session-side scan, so only js/session.js was covered)
  { id: 'a three-line const { machine } = session in a page module', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const {\n    machine\n  } = session; if (machine) globalThis.__z = 1;\n' },
  // (3b) `window.emu` destructured, then the Session reached through the result - in BOTH page-driving tools
  { id: 'const { session: ss } = window.emu; ss.machine (browser-check-lib)', file: 'tools/browser-check-lib.js',
    find: 'const at = () => page.evaluate(() => window.emu.machine.frameCount);\n',
    insert: 'const at9 = () => page.evaluate(() => { const { session: ss } = window.emu; return ss.machine.frameCount; });\n' },
  { id: 'const { session: ss } = window.emu; ss.machine (capture-images)', file: 'tools/capture-images.js',
    find: "const f = window.emu.machine.render(), src = document.createElement('canvas');\n",
    insert: "const { session: ss } = window.emu; if (ss.machine) globalThis.__z = 1;\n" },
  // (3c) an alias of the holder and then of its member, on separate lines
  { id: 'const e = window.emu; const s = e.session; s.machine', file: 'tools/browser-check-lib.js',
    find: 'const at = () => page.evaluate(() => window.emu.machine.frameCount);\n',
    insert: 'const e = window.emu; const s = e.session; const at8 = () => page.evaluate(() => s.machine.frameCount);\n' },
  // (3d) a declaration split after the `=`
  { id: 'const sess =\\n page.session; sess.machine (a declaration split after =)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const sess4 =\n    page.session; if (sess4.machine) globalThis.__z = 1;\n', use: 'if (sess4.machine)' },
  // (4) a key bound TWICE: last-one-wins let the reach through in one order, and flagged an unrelated use in the other
  { id: "const k='_shown' then later const k='x'; this[k] (two bindings, reach first)", file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: "    const k = '_shown'; if (this[k]) globalThis.__z = 1;\n  }\n  laterProbe() {\n    const k = 'x'; if (k) globalThis.__z = 2;\n" },
  // (rewritten with the scoped reader) The row used to plant `const k = 'x'; ... { const k = '_shown'; } if (page[k])`
  // and require a catch. That expectation was a FALSE POSITIVE: the inner `k` is block-scoped, so `page[k]` is
  // `page['x']` and reaches nothing. A line scanner had to flag it (it could not see the block); the scoped reader
  // resolves `k` where it is used. The reach is made real here - one binding REASSIGNED, so `k` may be either value at
  // the use - and the old plant is kept below as an `allow` row, so the closed false positive is pinned too.
  { id: "let k='x', later k='_shown'; page[k] (one binding, reassigned before the reach)", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  let k = 'x'; if (k) globalThis.__z = 2;\n  k = '_shown'; if (page[k]) globalThis.__z = 1;\n", use: 'if (page[k])' },
  { id: "const k='x', and a block's own const k='_shown'; page[k] is page['x'] (allowed: the old false positive)", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  const k = 'x'; if (k) globalThis.__z = 2;\n  { const k = '_shown'; } if (page[k]) globalThis.__z = 1;\n", expect: 'allow' },
  // ---- round 3, the final commit: what a per-line or parenthesis-blind rule still missed ----
  // (item 1) a `//` inside a STRING is not a comment: a naive per-line strip hid the rest of this line, reach and all
  { id: "a // inside a string does not hide the reach on its line", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  if (location.href !== 'http://a') page.session.machine.z = 1;\n" },
  // (item 2) the Session side, whole-file: an alias of `this` split after the `=`, assigned after a bare `let`, and a
  // destructure of the machine out of an alias declared on an earlier line
  { id: 'const self =\\n this; self._shown (the Session alias split after =)', file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: '    const self =\n      this; if (self._shown) globalThis.__z = 1;\n', use: 'if (self._shown)' },
  { id: 'let self; self = this;\\n self._shown (a bare assignment in the Session)', file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: '    let self; self = this;\n    if (self._shown) globalThis.__z = 1;\n', use: 'if (self._shown)' },
  { id: 'const self = this;\\n const {\\n _shown\\n} = self (a multi-line destructure of an alias)', file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: '    const self = this;\n    const {\n      _shown\n    } = self; if (_shown) globalThis.__z = 1;\n', use: 'const {\n      _shown' },
  // (item 3) a holder assigned after a bare `let` to window.emu, then the Session reached through it - in BOTH tools
  { id: 'let e9; e9 = window.emu; s9.machine (browser-check-lib)', file: 'tools/browser-check-lib.js',
    find: 'const at = () => page.evaluate(() => window.emu.machine.frameCount);\n',
    insert: 'let e9; e9 = window.emu; const s9 = e9.session;\nconst at9 = () => page.evaluate(() => s9.machine.frameCount);\n', use: 's9.machine' },
  { id: 'let e9; e9 = window.emu; s9.machine (browser-check)', file: 'tools/browser-check.js',
    find: 'window.emu.machine.cartPort.type)) === \'multi\');\n',
    insert: '  let e9b; e9b = window.emu; const s9b = e9b.session;\n  if (s9b.machine) globalThis.__z = 1;\n', use: 's9b.machine' },
  // and a parenthesised right side, spread over lines
  { id: 'const sess5 = (\\n page.session\\n); sess5.machine (a parenthesised holder)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const sess5 = (\n    page.session\n  ); if (sess5.machine) globalThis.__z = 1;\n', use: 'if (sess5.machine)' },
  // ---- the scoped reader (tests/js-reach.js): the shapes THE BOUNDARY used to list as uncatchable by a line scanner ----
  // Each of these is green under the line scanner of 297b7de (measured: the row run against that scanner) and must be
  // caught here AT THE PLANTED LINE.
  // (a) a Session handed to a function of the same file through a parameter of ANY name: the call site gives it
  { id: 'const spill = (sess) =>\\n sess.machine; spill(page.session) (a parameter, arrow)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const spill = (sess) =>\n    sess.machine;\n  spill(page.session);\n', use: 'sess.machine' },
  { id: 'function grab({ machine }) {} grab(session) (a destructured parameter)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  function grab({ machine }) { return machine; }\n  grab(session);\n' },
  { id: 'this.peekAt(this); peekAt(who) { who._shown } (a Session method given the Session)', file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: '    this.peekAt(this);\n  }\n  peekAt(who) {\n    if (who._shown) globalThis.__z = 1;\n', use: 'if (who._shown)' },
  { id: 'new Holder(session); this.s.machine (a class of the file keeps it in a field)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  class Holder { constructor(s) { this.s = s; }\n    poke() { return this.s.machine; } }\n  new Holder(session);\n', use: 'poke()' },
  // (b) a Session carried in a structure built in the file
  { id: 'const box = { s: page.session };\\n box.s.machine (an object literal)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const box = { s: page.session };\n  if (box.s.machine) globalThis.__z = 1;\n', use: 'if (box.s.machine)' },
  { id: 'const list = [session];\\n list[0].machine (an array literal)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const list = [session];\n  if (list[0].machine) globalThis.__z = 1;\n', use: 'if (list[0].machine)' },
  { id: 'const bag = {}; bag.s = session;\\n bag.s.machine (a property assigned later)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  const bag = {}; bag.s = session;\n  if (bag.s.machine) globalThis.__z = 1;\n', use: 'if (bag.s.machine)' },
  // (c) the field named as a string argument to a general helper
  { id: "Reflect.get(session, 'machine')", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  if (Reflect.get(session, 'machine')) globalThis.__z = 1;\n" },
  { id: "Object.getOwnPropertyDescriptor(this, '_shown') (in the Session)", file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: "    if (Object.getOwnPropertyDescriptor(this, '_shown')) globalThis.__z = 1;\n" },
  // (d) a key built from constants: the reader folds `+` over known strings
  { id: "const key = 'ma' + 'chine'; session[key] (a folded key)", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  const key = 'ma' + 'chine'; if (session[key]) globalThis.__z = 1;\n" },
  // (e) the FAIL-SAFE false positives THE BOUNDARY listed: a name learned for the whole file is now a binding in its
  // own scope, so a different binding of the same name elsewhere is not the Session (old: flagged; now: allowed)
  { id: 'const self = this in one method, (self) => self._shown on a record in another (allowed: a shadowing parameter)', file: 'js/session.js',
    find: '  welcomeSound() {\n',
    insert: '    const self = this; if (self) globalThis.__z = 2;\n  }\n  probeRecords(list) {\n    return list.map((self) => self._shown);\n', expect: 'allow' },
  { id: "const k = 'machine' in a block, for (let k = 0; ...) page[k] (allowed: a different k)", file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: "  { const k = 'machine'; if (k) globalThis.__z = 2; }\n  for (let k = 0; k < 2; k++) if (page[k]) globalThis.__z = 1;\n", expect: 'allow' },
  // (f) the reader's SELF-CHECK: a file it cannot read whole is reported where the reading broke. An unclosed block
  // comment hides everything after it - every reach in the rest of the file - so the finding is the comment itself.
  { id: 'an unclosed /* comment hiding a reach (the self-check reports the file unreadable there)', file: 'js/ui/claude.js',
    find: '  }, { every: true, beforeView: true });\n',
    insert: '  /* an unclosed comment\n  if (page.session.machine) globalThis.__z = 1;\n' },
  // and it dies with the accessor: replace the getter in js/ui/main.js with a plain field and the real tree no longer
  // passes, because tools' `emu.machine` is then reaching a field that is no longer named as the shown machine
  // this row's plant is in js/ui/main.js, but the FINDING it must produce is in the tools: with the accessor gone,
  // their `emu.machine` is an unlicensed reach. So the harness is told which file the finding belongs to.
  { id: 'the exemption dies with the accessor (main.js no longer defines it)', file: 'js/ui/main.js',
    find: 'get machine() { return session.shownMachine; },', mutateTo: 'machine: session.shownMachine,',
    findingIn: 'tools/browser-check-lib.js' },
];
// ONE shared copy for every row, and each row RESTORES the file it planted (checked by hash below), rather than copying
// the whole repository per row. Copying per row is what made this suite exceed its 240 s gate limit in CI once the rows
// grew past a dozen: each copy is the whole tree and the scan then walks it. A copy is made once, the plant is applied
// to one file, the scan runs, and the file is put back byte for byte before the next row - so no plant can mask another
// and the cost is one copy plus one scan per row.
const SHARED = path.join(work, 'repo');
fs.mkdirSync(SHARED, { recursive: true });
// tracked files only, like the test-time branch's copy: `git ls-files` cannot pick up .git or every other worktree.
// A tree with no .git falls back to a tar that excludes them (measured: the same 464 files, 0.27 s).
{
  const inGit = fs.existsSync(path.join(ROOT, '.git'));
  const cmd = inGit
    ? `cd ${JSON.stringify(ROOT)} && git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C ${JSON.stringify(SHARED)}`
    : `cd ${JSON.stringify(ROOT)} && tar -cf - --exclude=./.git --exclude=./.claude --exclude=./node_modules . 2>/dev/null | tar -xf - -C ${JSON.stringify(SHARED)}`;
  cp.execFileSync('bash', ['-c', cmd]);
}
const hash = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');

for (const c of CASES) {
  const p = path.join(SHARED, c.file);
  const pristine = fs.readFileSync(p);
  const before = hash(p);
  const src = pristine.toString('utf8');
  const count = src.split(c.find).length - 1;
  if (count !== 1) { check(`${c.id}: the plant lands`, false, `anchor occurs ${count}x`); continue; }
  const planted = c.mutateTo !== undefined ? src.replace(c.find, c.mutateTo) : src.replace(c.find, c.find + c.insert);
  fs.writeFileSync(p, planted);
  // THE LINE THE PLANT LANDED ON, taken from the planted text itself. A catch must name THIS line, not merely the
  // file: a scan that reported every finding of a file at a hard-coded line 7 passed the old `${file}:` check.
  // A multi-line plant carries the reach on one of its lines, so the case names that fragment (`use`); without one the
  // reach is the first line (`mutateTo` replaces one line). The offset is the fragment's first occurrence inside the
  // planted text, in the planted file.
  const at = planted.indexOf(c.use !== undefined ? c.use : (c.mutateTo !== undefined ? c.mutateTo : c.insert));
  const plantLine = at < 0 ? NaN : planted.slice(0, at).split('\n').length;
  let out, threw = null;
  try {
    // IN PROCESS, not a spawn: the scan over a root is now a function of that root, and 31 spawns at 0.9 s each is what
    // pushed this suite to 95 s in CI. A throw is caught and reported as a crash below, exactly as a spawn's would be.
    const { rawMachineUses } = require('./chat-leaks.test.js');
    const found = rawMachineUses(SHARED);
    out = found.length ? found.map((x) => `FAIL ${x}`).join('\n') : 'ok   no raw machine reach';
  } catch (e) {
    out = `FAIL chat-leaks ${e && e.stack ? e.stack : e}`;
    threw = e;
  } finally {
    // restore and CHECK it, in a finally so a throw cannot leave the shared copy planted for the next row
    fs.writeFileSync(p, pristine);
    check(`${c.id}: the file is restored exactly (sha256)`, hash(p) === before, hash(p) === before ? '' : 'restore did not round-trip');
  }
  // A CRASH IS NOT A CATCH, and neither is a FAIL that does not come from the scan's own rule output. The scan's
  // findings are lines like `js/ui/x.js:12 (x.machine)`; a throw is reported as `FAIL chat-leaks <stack>`, which
  // used to look identical to a catch. So: any stack, any exception text, or any FAIL without a `file:line` finding is
  // a crash, whatever its exit status.
  const crashed = !!threw || /ReferenceError|TypeError|SyntaxError|\n\s+at\s/.test(out) || /FAIL chat-leaks\b/.test(out);
  const findings = out.split('\n').filter((l) => /^FAIL\b/.test(l) && !/FAIL chat-leaks\b/.test(l));
  const hasFinding = findings.some((l) => /\S+\.js:\d+/.test(l));
  // a caught row must name the file AND THE LINE the plant went into, not merely the file. `namesPlant` used to test
  // `${file}:` alone, so a mutant that reported every finding of a file at a hard-coded line 7 passed: the line is
  // known, because this harness planted it.
  // the finding may be the plant's own file, or a file the row names (`findingIn`) when the plant is what un-licenses
  // a use that lives elsewhere (and then the LINE is the tool's own use, not the plant's: the row gives `findingLine`)
  const want = c.findingIn || c.file;
  // a row whose finding lives in ANOTHER file (`findingIn`) names it and, from the shared copy, the line of its own
  // reach: `find`/`insert` describe the plant, not the use that stops being licensed.
  const wantLine = c.findingIn
    ? (c.findingLine !== undefined ? c.findingLine
      : fs.readFileSync(path.join(SHARED, want), 'utf8').split('\n').findIndex((l) => /\bemu\s*\.\s*machine\b/.test(l)) + 1)
    : plantLine;
  const namesPlant = findings.some((l) => l.includes(`${want}:${wantLine} `) || l.includes(`${want}:${wantLine})`));
  const allow = c.expect === 'allow';
  const passed = !crashed && !/^FAIL /m.test(out);
  const caught = !crashed && hasFinding && namesPlant;
  let detail = '';
  if (allow && !passed) detail = 'flagged by the scan';
  else if (!allow && !caught) {
    // (a finding that is not `file:line` at all is a crash-shaped output, whatever printed it: label it as one)
    detail = crashed || (out.includes('FAIL') && !hasFinding) ? 'the plant made the scan fail without a file:line finding'
      : hasFinding ? `caught, but not at ${want}:${wantLine}` : 'still green';
  }
  check(`the scan ${allow ? 'allows' : 'catches'} ${c.id}${allow ? '' : ` (at ${want}:${wantLine})`}`, allow ? passed : caught, detail);
}

check('the scan still passes on the real tree (the new rules flag nothing there)', (() => {
  const { rawMachineUses } = require('./chat-leaks.test.js');
  return rawMachineUses(ROOT).length === 0;
})(), '');

console.log(fail ? `\n${fail} FAILED` : '\nall scan-coverage checks passed');
process.exitCode = fail ? 1 : 0;
