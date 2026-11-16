// Runtime guard for the Node process.exit() deadlock (see tests/exitcode.test.js for the static scan and the
// story). Loaded into every suite with:
//
//   NODE_OPTIONS=--require .../no-exit.js   (set by tests/all.js, so child node processes get it too)
//
// Why a runtime guard on top of the static scan: the scan matches one spelling of the call, and there are at
// least nine ways to reach the same API -- process['exit'], globalThis.process.exit, a destructured or aliased
// exit, one built from a template literal, a regex that contains a quote and defeats a naive comment stripper,
// process.reallyExit, and kill(pid, 'SIGKILL') on itself. A completed suite must not call any of them.
//
// A suite that does is FAILED by name and the run exits non-zero, rather than silently hanging under load.
//
// It applies to SUITES and their child processes, not to the tools a suite runs. A tool may use exit() as a
// success signal -- tools/gen-page-preload.js exits 0 when the preload list is already right -- and failing that
// would fail every suite that runs it. So the preload arms itself for every process EXCEPT one whose entry
// script is a tool, which keeps the coverage the coordinator asked for (a suite spawning another node process is
// guarded, including `-e` children, which have no entry script at all) while leaving tools statically covered
// only, as they already are.
// The rule: the entry script really is inside this repo's tools/ directory. Resolved, not matched against the
// text, so a helper at tests/tools/foo.js cannot fall under it and every nested tool
// (tools/mame-diff/run.js) is covered by it. An `-e` child has no entry script at all, so it stays guarded.
const ENTRY = process.argv[1] ? require('path').resolve(process.argv[1]) : '';
const TOOLS = require('path').join(__dirname, '..', 'tools') + require('path').sep;
if (ENTRY.startsWith(TOOLS)) return;   // a tool, not a suite or a child of one: leave process.exit alone

const REPORT = () => {
  const stack = new Error('process.exit called').stack || '';
  const user = stack.split('\n').filter((l) => l.includes(' at ') && !l.includes(__filename) && !/node:internal/.test(l));
  const frame = user[0] || '';
  // Report a repo-relative path: an absolute one is machine-specific noise in the gate's output.
  const m = /\(?([^()\s]+):(\d+:\d+)\)?$/.exec(frame.trim());
  if (!m) return { file: '(unknown caller)', at: '?' };
  const root = require('path').join(__dirname, '..');
  const rel = m[1].startsWith(root + '/') ? m[1].slice(root.length + 1) : m[1];
  return { file: rel, at: m[2] };
};

// A suite finished its work when Node's event loop is about to drain. Calling exit() at that point is the
// deadlock path: the main thread joins a Sparkplug compile that waits for a GC it will never run.
//
// What this does NOT do is let the call return. A tool that uses exit() as "stop here" (tools/gen-page-preload.js
// exits 0 when the list is already right, 1 when it is stale) would then fall through into the code below it and
// do something else entirely -- caught in review when the guard made that tool write the page instead of
// reporting. So a guarded call reports, marks the failure and ends the process at once by throwing, which also
// keeps Node out of Environment::Exit.
let ended = false;
class ProcessExitBlocked extends Error {}
const fail = (code, how) => {
  const { file, at } = REPORT();   // at CALL time, so it names the suite, not this file's load frame
  // Report the first call only: a suite that exits in a loop would otherwise bury the run in identical lines.
  // A failing suite is already reported by its own output; this line names the file and the spelling used.
  // The shape is shared with the static scan so a reader sees one format for one rule:
  //   FAIL <file>: <spelling>(code N) at <line:col>
  if (!ended) {
    ended = true;
    if (process.env.CLOADM_EXIT_GUARD_QUIET !== '1') {
      // One shape across both guards (static scan and this one), so a failure reads the same from either:
      //   FAIL <file>: process.exit() called at <line>: <spelling>
      // <spelling> is the call as it was made, as the static scan shows it. Here the code it asked for is
      // included, since a static scan cannot know it.
      console.log(`\nFAIL ${file}: process.exit() called at ${at.split(':')[0]}: ${how} (code ${code})`);
    }
    process.exitCode = 1;
  }
  // EVERY call throws, not just the first. A suite that catches the throw and calls exit() again must not get
  // a silent return from the second call and then carry on to the end: that is the failure escaping.
  throw new ProcessExitBlocked(`${how} at ${file}:${at}`);
};

for (const fn of ['exit', 'reallyExit']) {
  const original = process[fn];
  if (typeof original !== 'function') continue;
  process[fn] = function (...args) { fail(args[0], `process.${fn}()`); return undefined; };
}

// A suite that kills its own process group takes the gate down with it; treat it the same way.
const originalKill = process.kill;
process.kill = function (pid, sig) {
  if (pid === process.pid || pid === -process.pid) { fail(undefined, `process.kill(${pid}, ${JSON.stringify(sig)})`); return true; }
  return originalKill.apply(this, arguments);
};
