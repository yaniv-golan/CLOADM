// Work folders for the MAME comparisons: every run gets its own (fs.mkdtemp under the system temp folder), so
// runs of the same machine at the same time (several agents on one computer) never share ROMs, pipes, MAME
// settings or captures. A folder is removed when the process exits, also on Ctrl-C (SIGINT) and SIGTERM,
// unless keepWorkDir() asked to keep it (difference images to look at, --keep).
const fs = require('fs'), os = require('os'), path = require('path');

const dirs = new Map();       // folder -> keep
const children = new Set();   // MAME processes started with spawn, stopped on a signal
let hooked = false;

function cleanup() {
  for (const p of children) { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }
  children.clear();
  for (const [dir, keep] of dirs) if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', cleanup);
  // A signal handler is the one place process.exitCode cannot be used: nothing is waiting to drain, and the
  // process must actually terminate, so returning from the handler would leave the run going. Instead the
  // signal is re-raised after cleanup with this listener removed, so the default action terminates the process
  // with the conventional 128+n - the same code process.exit(128+n) gave, without the Exit deadlock.
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15]]) {
    process.on(sig, () => {
      cleanup();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

// a new, empty work folder for this run; `label` names it (e.g. the profile)
function workDir(label) {
  hook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mame-diff-${String(label).replace(/[^\w.-]/g, '_')}-`));
  dirs.set(dir, false);
  return dir;
}
// keep this run's folder after exit (says where, and why)
function keepWorkDir(dir, why) {
  if (dirs.has(dir) && !dirs.get(dir)) console.log(`(${why}: kept in ${dir})`);
  if (dirs.has(dir)) dirs.set(dir, true);
}
function trackChild(proc) {
  hook();
  children.add(proc);
  proc.on('exit', () => children.delete(proc));
}

module.exports = { workDir, keepWorkDir, trackChild };
