// Run: node tests/gzip-platform.test.js
//
// The snapshot fixtures and the scenario reports of the session tests hold what a snapshot file CONTAINS, not the bytes
// or the length of the gzip around it: those are the writing machine's (the header's operating system byte, and the
// deflate implementation: a Mac gives 19 and another stream). tests/gzip-platform.js stands in for such a machine. Here:
//  * it really changes the file (the same state, other bytes, another length, byte 9 = 19) and not what it holds;
//  * the suites that read snapshot files pass under it, so a raw-bytes or file-size comparison put back in one of them
//    turns it red here on Linux, as it did on a Mac.
const cp = require('child_process'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const { sameGzipContents } = require('./gzip-contents');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const SHIM = path.join(__dirname, 'gzip-platform.js');
// (a run of the whole suite may itself preload the stand-in through NODE_OPTIONS: the children here choose for themselves)
const CLEAN = Object.assign({}, process.env, { NODE_OPTIONS: '' });

// the same machine's snapshot file, written natively and written by the stand-in (a child process: it replaces a global)
const snapshotBytes = (shim) => cp.execFileSync(process.execPath, [...(shim ? ['-r', SHIM] : []), '-e', `
  const Emu = require(${JSON.stringify(path.join(__dirname, 'load'))})();
  (async () => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64'); for (let i = 0; i < 5; i++) s.shownMachine.runFrame();
    process.stdout.write(Buffer.from((await s.snapshotFile(new Date(1e12))).bytes).toString('base64')); })();`], { maxBuffer: 1 << 28, env: CLEAN }).toString();
const native = Buffer.from(snapshotBytes(false), 'base64'), other = Buffer.from(snapshotBytes(true), 'base64');
check('the stand-in writes a different file: other bytes, another length, the macOS operating system byte', Buffer.compare(native, other) !== 0 && native.length !== other.length && other[9] === 19 && native[9] !== 19,
  `native ${native.length} bytes (byte 9 = ${native[9]}), stand-in ${other.length} bytes (byte 9 = ${other[9]})`);
check('... of the same contents: the comparison by contents calls them the same', sameGzipContents(native, other).same && Buffer.compare(zlib.gunzipSync(native), zlib.gunzipSync(other)) === 0);
check('(set-up) the module under test is the real one', typeof Emu.decodeSnapshot === 'function');

// the suites that read snapshot files, under the stand-in
for (const suite of ['session-library', 'session-drives', 'snapshot', 'state-split']) {
  const r = cp.spawnSync(process.execPath, ['-r', SHIM, path.join(__dirname, `${suite}.test.js`)], { encoding: 'utf8', maxBuffer: 1 << 28, env: CLEAN });
  const fails = (r.stdout.match(/^FAIL .*/gm) || []).map((l) => l.slice(0, 160));
  check(`${suite}.test.js passes under the stand-in (another deflate, the macOS header byte)`, r.status === 0 && !fails.length, fails.slice(0, 3).join(' | ') || (r.stderr || '').slice(0, 200));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
