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
//
// Resolved means REAL paths on both sides. __dirname is already a real path (Node resolves a required module
// through symlinks), while argv[1] is the spelling the caller typed: a temp directory can reach us through a
// symlinked path, so the same file arrives under two different spellings, and a prefix comparison between them
// mismatches. That made a tool under a resolved path look like a suite, which fails it for exiting 0 -- the
// direction that breaks a working tool. A path that cannot be resolved (already gone) is compared as given, so the
// guard still decides.
//
// An `-e` child has no entry script: process.argv[1] is absent, and it must not be resolved anyway --
// fs.realpathSync('') returns the CWD, so a realpath of the empty string would make an `-e` child's "entry" its
// current directory, and run from inside tools/ (cd tools/mame-diff) it would be exempted as a tool. That is a
// process with no entry script at all, which the rule has always guarded; it is guarded here by not resolving.
const path = require('path'), fs = require('fs');
const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return p; } };
const ARGV1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
const ENTRY = ARGV1 ? real(ARGV1) : '';     // no entry script: no path, and never the cwd
const TOOLS = path.join(real(path.join(__dirname, '..')), 'tools') + path.sep;
if (ENTRY && ENTRY.startsWith(TOOLS)) return;   // a tool, not a suite or a child of one: leave process.exit alone

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

// A summary printed while the process is shutting down is not the suite reaching its summary.
//
// The gate fails a suite that stops part-way by looking for its summary line (tests/suite-verdict.js). But a suite
// that stops part-way still drains the event loop, so it can print "all passed" from a beforeExit or an exit
// handler -- and then the line the gate reads is one printed by a process that already gave up. On main that passed:
// `process.on('exit', () => console.log('all passed')); (async () => { await new Promise(() => {}); })();` was a
// green suite. The same shape from 'beforeExit' passed too.
//
// The shutdown flag travels to the runner in-band as a NUL in the stdout stream: the first write made after the
// first shutdown event is prefixed with one, and the runner cuts the suite's output at the first NUL before judging
// its summary (liveOutput in tests/suite-verdict.js). The marker is unforgeable in the direction that matters: it is
// written by THIS process only, and only into its own stdout, so a NUL anywhere in a suite's stream means this
// process reached shutdown before that byte. Two cases must not cut, and both did in earlier versions (round 2 of
// review, and a probe here):
//  * the live writes end WITHOUT a newline (`process.stdout.write('working')`), so the marker lands mid-line. Cutting
//    only at a line-initial marker let a shutdown-time "all passed" read as live -- the gate passed a suite that
//    stopped part-way. So the cut is at ANY NUL this process wrote.
//  * a suite echoes a guarded CHILD's captured stdout. The child has its own stdout, so its marker never reaches this
//    process's stream -- unless the child shares fd 1 (stdio 'inherit'), or the parent itself was the one shutting
//    down. The first of those is not fixed by this scheme; it is stated in tests/suite-verdict.js as the limit it is.
//
// The failure tail still shows the marked text (with the NUL removed): a real suite's "FAIL the test did not finish"
// from an exit handler must stay visible.
//
// Both events are marked. Most probes in tests/allsummary.test.js drain the event loop, so Node emits `beforeExit`
// and the latch is already set; the `exit` listener exists for the CRASH path -- an uncaught throw skips `beforeExit`
// but still runs `exit` handlers -- and the crash probe in 1c is the case that reaches it, so removing this listener
// turns that probe red.
// Writes that bypass process.stdout.write (fs.writeSync(1, ...)) are not marked; no suite here writes that way.
let shuttingDown = false;
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, ...rest) {
  if (!shuttingDown) return originalWrite.call(this, chunk, ...rest);
  // A non-string chunk is marked on the BYTES, not by stringifying it. String(chunk) turns a Buffer into "233,65"; a
  // latin1 string written back as a string is re-encoded (0xE9 leaves as 0xC3 0xA9). Both spellings change what a
  // binary write meant. Prefixing the Buffer keeps every byte (probes in allsummary 1c).
  if (typeof chunk === 'string') return originalWrite.call(this, '\u0000' + chunk, ...rest);
  return originalWrite.call(this, Buffer.concat([Buffer.from([0]), chunk]), ...rest);
};
// Registered at preload time, so before any handler the suite adds: the marker must be on before the first
// shutdown-time write, and Node calls listeners in the order they were added.
//
// The latch is NOT cleared on a later turn. A beforeExit listener that schedules work makes Node go round the loop
// again, and clearing the latch with a setImmediate was tried and is much worse than the problem: the pending
// setImmediate itself keeps the loop alive, 'beforeExit' fires again, and the process never exits -- every suite in
// the gate hung until its timeout. So a suite that continues from beforeExit has its continued prints marked, and
// reads as having printed no summary while running (a known limit, kept as stated rather than
// traded for a hang). No suite here does that.
process.on('beforeExit', () => { shuttingDown = true; });
process.on('exit', () => { shuttingDown = true; });
